import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { stripDsmlResidue } from "./thinking.js";
import { createQoderToolCallIdMapper } from "./tool-call-id.js";

/** OpenAI-style tool definition sent to the Qoder API. */
interface QoderTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

/** OpenAI-style tool call within an assistant message. */
interface QoderToolCall {
  id?: string;
  type: "function";
  function: { name?: string; arguments: string };
}

type QoderTextPart = { type: "text"; text: string };
type QoderImagePart = { type: "image_url"; image_url: { url: string } };
type QoderContent = string | Array<QoderTextPart | QoderImagePart>;

/** OpenAI-style message sent to the Qoder API. */
interface QoderMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: QoderContent | null;
  reasoning_content?: string;
  tool_calls?: QoderToolCall[];
  tool_call_id?: string;
}

export function getContentText(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => {
        if (c.type === "text") return (c as TextContent).text;
        if (c.type === "thinking") return (c as ThinkingContent).thinking;
        return "";
      })
      .join("");
  }
  return "";
}

/** The image blocks of a message, in order. Empty when there are none. */
export function getContentImages(msg: Message): ImageContent[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((c): c is ImageContent => c.type === "image");
}

export function transformTools(tools: Tool[]): QoderTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function transformMessagesForQoder(messages: Message[]): QoderMessage[] {
  const normalizedMessages: QoderMessage[] = [];

  // Qoder rejects tool call IDs outside `^[a-zA-Z0-9_-]{1,64}$`; pi's OpenAI
  // Responses adapter produces internal IDs containing `|`. Rewrite them for
  // the wire only. droppedToolCallIds below intentionally keeps comparing raw
  // internal IDs: the drop filter runs before mapping on both sides.
  const mapToolCallId = createQoderToolCallIdMapper();

  // Dropping an assistant turn (below) also invalidates its tool calls: the
  // result that follows would refer to a tool_calls entry that is no longer in
  // the request, and upstreams reject that with "tool must follow a message
  // with tool_calls".
  const droppedToolCallIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Skip error or aborted messages
    if (
      msg.role === "assistant" &&
      ((msg as AssistantMessage).stopReason === "error" || (msg as AssistantMessage).stopReason === "aborted")
    ) {
      const am = msg as AssistantMessage;
      if (Array.isArray(am.content)) {
        for (const block of am.content) {
          if (block.type === "toolCall") {
            const id = (block as ToolCall).id;
            if (id) droppedToolCallIds.add(id);
          }
        }
      }
      continue;
    }

    if (msg.role === "user") {
      let content: QoderContent = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const hasImage = msg.content.some((c) => c.type === "image");
        if (hasImage) {
          content = msg.content
            .map((c): QoderTextPart | QoderImagePart | null => {
              if (c.type === "text") {
                return { type: "text", text: (c as TextContent).text };
              }
              if (c.type === "image") {
                const img = c as ImageContent;
                return {
                  type: "image_url",
                  image_url: {
                    url: `data:${img.mimeType};base64,${img.data}`,
                  },
                };
              }
              return null;
            })
            .filter((p): p is QoderTextPart | QoderImagePart => p !== null);
        } else {
          content = getContentText(msg);
        }
      }
      normalizedMessages.push({
        role: "user",
        content,
      });
    } else if (msg.role === "assistant") {
      const am = msg as AssistantMessage;
      let content = "";
      let reasoningContent = "";
      const toolCalls: QoderToolCall[] = [];

      if (Array.isArray(am.content)) {
        for (const block of am.content) {
          if (block.type === "text") {
            content += (block as TextContent).text;
          } else if (block.type === "thinking") {
            // Replay reasoning out-of-band. Qoder returns it through
            // reasoning_content; putting it in visible content can pollute
            // later turns, and stored text may contain leaked DSML markup.
            reasoningContent += stripDsmlResidue((block as ThinkingContent).thinking);
          } else if (block.type === "toolCall") {
            const tc = block as ToolCall;
            toolCalls.push({
              id: mapToolCallId(tc.id),
              type: "function",
              function: {
                name: tc.name,
                arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
              },
            });
          }
        }
      } else {
        content = am.content || "";
      }

      // Qoder's gateway drops assistant messages whose content is null, which
      // orphans the following tool_result and makes dmodel/ultimate upstreams
      // reject the request ("tool must follow a message with tool_calls").
      // When an assistant turn has tool calls or reasoning but no visible
      // text, inject a placeholder so the gateway keeps the message and its
      // reasoning history.
      const mapped: QoderMessage = {
        role: "assistant",
        content: content || (toolCalls.length > 0 || reasoningContent ? " " : null),
      };
      if (reasoningContent) {
        mapped.reasoning_content = reasoningContent;
      }
      if (toolCalls.length > 0) {
        mapped.tool_calls = toolCalls;
      }
      normalizedMessages.push(mapped);
    } else if (msg.role === "toolResult") {
      // Consume the whole run of consecutive tool results before emitting the
      // images they returned. A `tool` message can only carry text, so tool
      // images have to ride on a following `user` message; emitting one per
      // result would interrupt the tool replies, and upstreams reject an
      // assistant `tool_calls` turn whose replies are split ("insufficient tool
      // messages following tool_calls message"). Instead emit every `tool`
      // reply first, collect the images, and append a single `user` message
      // after the run — the shape pi-ai's OpenAI provider uses.
      //
      // pi's `read` tool returns a text note plus an `image` block for
      // png/jpg/gif/webp/bmp, and screenshot tools do the same. getContentText()
      // maps every non-text block to "", so before this the images were dropped
      // silently: the TUI rendered the picture while the model received only
      // "Read image file [image/png]" and reported that it could not see
      // images. The leading label keeps the model from reading a bare image as
      // something the human just sent.
      const imageBlocks: QoderImagePart[] = [];
      let j = i;
      for (; j < messages.length; j++) {
        const trMsg = messages[j];
        if (trMsg.role !== "toolResult") break;
        const tr = trMsg as ToolResultMessage;
        // Drop results of an assistant turn that was skipped above, otherwise
        // they refer to a tool_calls entry no longer in the request.
        if (droppedToolCallIds.has(tr.toolCallId)) continue;
        normalizedMessages.push({
          role: "tool",
          tool_call_id: mapToolCallId(tr.toolCallId),
          content: getContentText(tr),
        });
        for (const img of getContentImages(tr)) {
          imageBlocks.push({
            type: "image_url",
            image_url: { url: `data:${img.mimeType};base64,${img.data}` },
          });
        }
      }
      i = j - 1;

      if (imageBlocks.length > 0) {
        normalizedMessages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `[${imageBlocks.length} image${imageBlocks.length === 1 ? "" : "s"} returned by the previous tool call]`,
            },
            ...imageBlocks,
          ],
        });
      }
    }
  }

  return normalizedMessages;
}
