import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Node, type SourceFile, SyntaxKind } from 'typescript/unstable/ast';
import {
  isCallExpression,
  isIdentifier,
  isJsxExpression,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
} from 'typescript/unstable/ast/is';
import { API } from 'typescript/unstable/sync';
import type { SettingsSearchEntry } from '../../src/shared/searchAnything';
import { categoryForSettingsRow } from '../../src/shared/settingsDeepLink';

const SETTINGS_TAGS = new Set([
  'SettingsRow',
  'SettingsSection',
  'SettingsPage',
  'SettingsExpandableRow',
  'SettingsSubRow',
]);

const LABEL_PROP: Record<string, string> = {
  SettingsRow: 'label',
  SettingsSubRow: 'label',
  SettingsExpandableRow: 'label',
  SettingsPage: 'title',
  SettingsSection: 'title',
};

export interface MissingSettingsRow {
  file: string;
  line: number;
  tag: string;
  label: string;
  category: string | null;
  /** dynamic：rowId 已有但标题是运行期计算，不进目录也不算缺失 */
  kind?: 'dynamic';
}

export interface SettingsCatalogExtraction {
  entries: SettingsSearchEntry[];
  missing: MissingSettingsRow[];
}

interface FnRange {
  key: string;
  file: string;
  name: string;
  start: number;
  end: number;
}

interface RowHit {
  file: string;
  line: number;
  tag: string;
  insertAt: number;
  pos: number;
  rowId?: string;
  label?: string;
  description?: string;
  fnKey: string;
}

interface FileFacts {
  imports: Map<string, { file: string; name: string }>;
  fns: FnRange[];
  rows: RowHit[];
  /** caller function → callee function keys */
  edges: Array<{ caller: string; callee: string }>;
  forwarders: Forwarder[];
  calls: CallSite[];
}

interface Forwarder {
  fnKey: string;
  rowId: { kind: 'prop'; name: string } | { kind: 'template'; prefix: string; param: string };
  labelProp: string;
  descriptionProp?: string;
}

interface CallSite {
  tag: string;
  file: string;
  line: number;
  insertAt: number;
  pos: number;
  fnKey: string;
  staticProps: Record<string, string>;
  present: Set<string>;
}

interface SettingsUse {
  fnKey: string;
  rowIdFwd?: Forwarder['rowId'];
  labelFwd?: string;
  descriptionFwd?: string;
}

export function repoRoot(): string {
  return path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) {
    base = path.join(repoRoot(), 'src/renderer', spec.slice(2));
  } else if (spec.startsWith('@shared/')) {
    base = path.join(repoRoot(), 'src/shared', spec.slice('@shared/'.length));
  } else if (spec.startsWith('.')) {
    base = path.resolve(path.dirname(from), spec);
  } else {
    return null;
  }
  const candidates = [
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, 'index.tsx'),
    path.join(base, 'index.ts'),
  ];
  return (
    candidates.find((candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) ?? null
  );
}

function staticText(expr: Node | undefined): string | undefined {
  if (!expr) return undefined;
  if (isStringLiteral(expr) || isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (isJsxExpression(expr)) return staticText(expr.expression);
  if (
    expr.kind === SyntaxKind.ParenthesizedExpression ||
    expr.kind === SyntaxKind.AsExpression ||
    expr.kind === SyntaxKind.SatisfiesExpression ||
    expr.kind === SyntaxKind.TypeAssertionExpression ||
    expr.kind === SyntaxKind.NonNullExpression
  ) {
    return staticText((expr as { expression?: Node }).expression);
  }
  if (isCallExpression(expr)) {
    const callee = expr.expression;
    const accessed =
      callee.kind === SyntaxKind.PropertyAccessExpression
        ? (callee as { name?: Node }).name
        : undefined;
    const name = isIdentifier(callee)
      ? callee.text
      : accessed && isIdentifier(accessed)
        ? accessed.text
        : '';
    if (name !== 't') return undefined;
    const arg = expr.arguments[0];
    if (arg && (isStringLiteral(arg) || isNoSubstitutionTemplateLiteral(arg))) return arg.text;
  }
  return undefined;
}

function jsxChildren(expr: Node): readonly Node[] {
  if (expr.kind === SyntaxKind.JsxFragment || expr.kind === SyntaxKind.JsxElement) {
    return (expr as { children?: readonly Node[] }).children ?? [];
  }
  return [];
}

/** 标题是片段时，里面只有一段静态文案也算（旁边的徽标不算标题）。 */
function staticLabel(expr: Node | undefined): string | undefined {
  const direct = staticText(expr);
  if (direct) return direct;
  const inner = expr && isJsxExpression(expr) ? expr.expression : expr;
  if (!inner) return undefined;
  const found = jsxChildren(inner)
    .map((child) => staticText(child))
    .filter((text): text is string => !!text);
  return found.length === 1 ? found[0] : undefined;
}

function forwardedIdent(expr: Node | undefined): string | undefined {
  if (!expr) return undefined;
  if (isIdentifier(expr)) return expr.text;
  if (isJsxExpression(expr)) {
    if (expr.expression && isIdentifier(expr.expression)) return expr.expression.text;
    if (expr.expression) return forwardedIdent(expr.expression);
  }
  if (expr.kind === SyntaxKind.JsxFragment) {
    const names = jsxChildren(expr).flatMap((child) => {
      if (!isJsxExpression(child) || !child.expression || !isIdentifier(child.expression))
        return [];
      return [child.expression.text];
    });
    return names.length === 1 ? names[0] : undefined;
  }
  return undefined;
}

function rowIdForwarding(expr: Node | undefined): Forwarder['rowId'] | undefined {
  const inner = expr && isJsxExpression(expr) ? expr.expression : expr;
  if (!inner) return undefined;
  if (isIdentifier(inner)) return { kind: 'prop', name: inner.text };
  if (inner.kind !== SyntaxKind.TemplateExpression) return undefined;
  const template = inner as unknown as {
    head: { text: string };
    templateSpans: ReadonlyArray<{ expression: Node; literal: { text: string } }>;
  };
  const span = template.templateSpans[0];
  if (template.templateSpans.length !== 1 || !span) return undefined;
  if (!isIdentifier(span.expression) || span.literal.text !== '') return undefined;
  return { kind: 'template', prefix: template.head.text, param: span.expression.text };
}

function enclosing(fns: readonly FnRange[], pos: number): string {
  let best: FnRange | undefined;
  for (const fn of fns) {
    if (pos < fn.start || pos >= fn.end) continue;
    if (!best || fn.end - fn.start < best.end - best.start) best = fn;
  }
  return best?.key ?? '';
}

function stringConstIn(sf: SourceFile, name: string): string | undefined {
  let found: string | undefined;
  const visit = (node: Node | undefined) => {
    if (!node || found) return;
    if (node.kind === SyntaxKind.VariableDeclaration) {
      const decl = node as unknown as { name?: Node; initializer?: Node };
      if (decl.name && isIdentifier(decl.name) && decl.name.text === name) {
        found = staticText(decl.initializer);
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return found;
}

function boundString(
  expr: Node | undefined,
  sf: SourceFile,
  imports: FileFacts['imports'],
  sourceOf: (file: string) => SourceFile | undefined
): string | undefined {
  const inner = expr && isJsxExpression(expr) ? expr.expression : expr;
  if (!inner || !isIdentifier(inner)) return undefined;
  const local = stringConstIn(sf, inner.text);
  if (local) return local;
  const imported = imports.get(inner.text);
  if (!imported) return undefined;
  const other = sourceOf(imported.file);
  return other ? stringConstIn(other, imported.name) : undefined;
}

function readFacts(
  sf: SourceFile,
  file: string,
  sourceOf: (file: string) => SourceFile | undefined
): FileFacts {
  const facts: FileFacts = {
    imports: new Map(),
    fns: [],
    rows: [],
    edges: [],
    forwarders: [],
    calls: [],
  };
  const fns: FnRange[] = [];
  const pendingEdges: Array<{ pos: number; callee: string }> = [];
  const uses: SettingsUse[] = [];

  const visit = (node: Node | undefined) => {
    if (!node) return;
    if (node.kind === SyntaxKind.FunctionDeclaration) {
      const fn = node as unknown as { name?: { text: string }; pos: number; end: number };
      if (fn.name)
        fns.push({
          key: `${file}#${fn.name.text}`,
          file,
          name: fn.name.text,
          start: fn.pos,
          end: fn.end,
        });
    } else if (node.kind === SyntaxKind.VariableDeclaration) {
      const decl = node as unknown as {
        name?: Node;
        initializer?: Node & { pos: number; end: number; kind: SyntaxKind };
      };
      if (
        decl.name &&
        isIdentifier(decl.name) &&
        decl.initializer &&
        (decl.initializer.kind === SyntaxKind.ArrowFunction ||
          decl.initializer.kind === SyntaxKind.FunctionExpression)
      ) {
        fns.push({
          key: `${file}#${decl.name.text}`,
          file,
          name: decl.name.text,
          start: decl.initializer.pos,
          end: decl.initializer.end,
        });
      }
    } else if (node.kind === SyntaxKind.ImportDeclaration) {
      const decl = node as unknown as {
        moduleSpecifier?: Node;
        importClause?: {
          namedBindings?: Node & {
            kind: SyntaxKind;
            elements?: Iterable<{ propertyName?: { text: string }; name: { text: string } }>;
          };
        };
      };
      const spec = decl.moduleSpecifier;
      const named = decl.importClause?.namedBindings;
      if (
        spec &&
        isStringLiteral(spec) &&
        named?.kind === SyntaxKind.NamedImports &&
        named.elements
      ) {
        const resolved = resolveImport(file, spec.text);
        if (resolved) {
          for (const el of named.elements) {
            facts.imports.set(el.name.text, {
              file: resolved,
              name: el.propertyName?.text ?? el.name.text,
            });
          }
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  facts.fns = fns;

  const visitUses = (node: Node | undefined) => {
    if (!node) return;
    if (
      (isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) &&
      isIdentifier(node.tagName)
    ) {
      const tag = node.tagName.text;
      if (SETTINGS_TAGS.has(tag)) {
        const labelProp = LABEL_PROP[tag] ?? 'label';
        let rowId: string | undefined;
        let label: string | undefined;
        let description: string | undefined;
        let rowIdExpr: Node | undefined;
        let labelExpr: Node | undefined;
        let descriptionExpr: Node | undefined;
        let sawLabel = false;
        let sawRowId = false;
        for (const prop of node.attributes.properties) {
          if (
            !prop ||
            prop.kind !== SyntaxKind.JsxAttribute ||
            !prop.name ||
            !isIdentifier(prop.name)
          )
            continue;
          const value = staticLabel(prop.initializer);
          if (prop.name.text === 'rowId') {
            sawRowId = true;
            rowIdExpr = prop.initializer;
            rowId = value ?? boundString(prop.initializer, sf, facts.imports, sourceOf);
          }
          if (prop.name.text === labelProp) {
            sawLabel = true;
            labelExpr = prop.initializer;
            label = value;
          }
          if (prop.name.text === 'description') {
            descriptionExpr = prop.initializer;
            description = value;
          }
        }
        const pos = node.getStart(sf);
        const fnKey = enclosing(fns, pos);
        uses.push({
          fnKey,
          rowIdFwd: rowId ? undefined : rowIdForwarding(rowIdExpr),
          labelFwd: label ? undefined : forwardedIdent(labelExpr),
          descriptionFwd: forwardedIdent(descriptionExpr),
        });
        if (sawLabel && label && (!sawRowId || rowId)) {
          facts.rows.push({
            file,
            line: sf.getLineAndCharacterOfPosition(pos).line + 1,
            tag,
            insertAt: node.tagName.getEnd(),
            pos,
            rowId,
            label,
            description,
            fnKey,
          });
        }
      } else if (tag[0] === tag[0]?.toUpperCase()) {
        pendingEdges.push({ pos: node.getStart(sf), callee: tag });
        const staticProps: Record<string, string> = {};
        const present = new Set<string>();
        for (const prop of node.attributes.properties) {
          if (
            !prop ||
            prop.kind !== SyntaxKind.JsxAttribute ||
            !prop.name ||
            !isIdentifier(prop.name)
          )
            continue;
          present.add(prop.name.text);
          const value = staticLabel(prop.initializer);
          if (value) staticProps[prop.name.text] = value;
        }
        const pos = node.getStart(sf);
        facts.calls.push({
          tag,
          file,
          line: sf.getLineAndCharacterOfPosition(pos).line + 1,
          insertAt: node.tagName.getEnd(),
          pos,
          fnKey: enclosing(fns, pos),
          staticProps,
          present,
        });
      }
    } else if (isCallExpression(node) && isIdentifier(node.expression)) {
      pendingEdges.push({ pos: node.getStart(sf), callee: node.expression.text });
    }
    node.forEachChild(visitUses);
  };
  visitUses(sf);

  const usesByFn = new Map<string, SettingsUse[]>();
  for (const use of uses) {
    const list = usesByFn.get(use.fnKey) ?? [];
    list.push(use);
    usesByFn.set(use.fnKey, list);
  }
  for (const [fnKey, list] of usesByFn) {
    const only = list.length === 1 ? list[0] : undefined;
    if (!fnKey || !only?.rowIdFwd || !only.labelFwd) continue;
    facts.forwarders.push({
      fnKey,
      rowId: only.rowIdFwd,
      labelProp: only.labelFwd,
      descriptionProp: only.descriptionFwd,
    });
  }

  const localFn = new Map(fns.map((fn) => [fn.name, fn.key]));
  for (const edge of pendingEdges) {
    const imported = facts.imports.get(edge.callee);
    const callee = imported ? `${imported.file}#${imported.name}` : localFn.get(edge.callee);
    const caller = enclosing(fns, edge.pos);
    if (callee && caller && callee !== caller) facts.edges.push({ caller, callee });
  }
  return facts;
}

function pageSeeds(sf: SourceFile, imports: FileFacts['imports']): Map<string, Set<string>> {
  const seeded = new Map<string, Set<string>>();
  const visit = (node: Node | undefined, category: string | null) => {
    if (!node) return;
    let next = category;
    if (
      node.kind === SyntaxKind.BinaryExpression &&
      (node as unknown as { operatorToken?: { kind: SyntaxKind } }).operatorToken?.kind ===
        SyntaxKind.AmpersandAmpersandToken
    ) {
      const left = (node as unknown as { left?: Node }).left;
      if (
        left &&
        left.kind === SyntaxKind.BinaryExpression &&
        (left as unknown as { operatorToken?: { kind: SyntaxKind } }).operatorToken?.kind ===
          SyntaxKind.EqualsEqualsEqualsToken
      ) {
        const cmp = left as unknown as { left?: Node; right?: Node };
        if (
          cmp.left &&
          isIdentifier(cmp.left) &&
          cmp.left.text === 'activeCategory' &&
          cmp.right &&
          isStringLiteral(cmp.right)
        ) {
          next = cmp.right.text;
        }
      }
    }
    if (
      next &&
      (isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) &&
      isIdentifier(node.tagName) &&
      !SETTINGS_TAGS.has(node.tagName.text)
    ) {
      const imported = imports.get(node.tagName.text);
      if (imported) {
        const key = `${imported.file}#${imported.name}`;
        const cats = seeded.get(key) ?? new Set();
        cats.add(next);
        seeded.set(key, cats);
      }
    }
    node.forEachChild((child) => visit(child, next));
  };
  visit(sf, null);
  return seeded;
}

function propagate(
  seeds: Map<string, Set<string>>,
  facts: Map<string, FileFacts>
): Map<string, Set<string>> {
  const cats = new Map<string, Set<string>>();
  const queue: Array<{ key: string; category: string }> = [];
  for (const [key, set] of seeds) {
    for (const category of set) queue.push({ key, category });
  }
  const edges = new Map<string, string[]>();
  for (const fact of facts.values()) {
    for (const edge of fact.edges) {
      const list = edges.get(edge.caller) ?? [];
      list.push(edge.callee);
      edges.set(edge.caller, list);
    }
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const mark = `${item.key}@${item.category}`;
    if (seen.has(mark)) continue;
    seen.add(mark);
    const set = cats.get(item.key) ?? new Set();
    set.add(item.category);
    cats.set(item.key, set);
    for (const callee of edges.get(item.key) ?? [])
      queue.push({ key: callee, category: item.category });
  }
  return cats;
}

function fileCategories(byFn: Map<string, Set<string>>): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  for (const [key, cats] of byFn) {
    const file = key.slice(0, key.lastIndexOf('#'));
    const set = byFile.get(file) ?? new Set();
    for (const category of cats) set.add(category);
    byFile.set(file, set);
  }
  return byFile;
}

/** Toggle / ToolRow 这类把 rowId 和标题原样交给 SettingsRow 的组件，按调用点计入。 */
function expandForwarders(facts: Map<string, FileFacts>): void {
  const forwarders = new Map<string, Forwarder>();
  for (const fact of facts.values()) {
    for (const forwarder of fact.forwarders) forwarders.set(forwarder.fnKey, forwarder);
  }
  for (const fact of facts.values()) {
    const local = new Map(fact.fns.map((fn) => [fn.name, fn.key]));
    for (const call of fact.calls) {
      const imported = fact.imports.get(call.tag);
      const key = imported ? `${imported.file}#${imported.name}` : local.get(call.tag);
      const forwarder = key ? forwarders.get(key) : undefined;
      if (!forwarder) continue;
      const label = call.staticProps[forwarder.labelProp];
      if (!label) continue;
      let rowId: string | undefined;
      if (forwarder.rowId.kind === 'prop') {
        const name = forwarder.rowId.name;
        if (call.present.has(name) && !call.staticProps[name]) continue;
        rowId = call.staticProps[name];
      } else {
        const part = call.staticProps[forwarder.rowId.param];
        if (!part) continue;
        rowId = `${forwarder.rowId.prefix}${part}`;
      }
      fact.rows.push({
        file: call.file,
        line: call.line,
        tag: call.tag,
        insertAt: call.insertAt,
        pos: call.pos,
        rowId,
        label,
        description: forwarder.descriptionProp
          ? call.staticProps[forwarder.descriptionProp]
          : undefined,
        fnKey: call.fnKey,
      });
    }
  }
}

function kebab(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (slug) return slug;
  return `text-${createHash('sha1').update(label).digest('hex').slice(0, 8)}`;
}

function quote(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')}'`;
}

export function renderSettingsCatalog(entries: readonly SettingsSearchEntry[]): string {
  const lines = entries.map((entry) => {
    const description = entry.description ? `, description: ${quote(entry.description)}` : '';
    return `  { id: ${quote(entry.id)}, category: ${quote(entry.category)}, title: ${quote(entry.title)}${description} },`;
  });
  return `// GENERATED FILE – regenerated by pnpm settings:catalog; do not edit
import type { SettingsSearchEntry } from './searchAnything';

export const GENERATED_SETTINGS_CATALOG: readonly SettingsSearchEntry[] = [
${lines.join('\n')}
];
`;
}

interface Analysis {
  entries: SettingsSearchEntry[];
  missing: MissingSettingsRow[];
  patches: Array<{ file: string; insertAt: number; id: string }>;
}

function analyze(root: string): Analysis {
  const api = new API();
  try {
    const snapshot = api.updateSnapshot({ openProjects: [path.join(root, 'tsconfig.json')] });
    const project = snapshot
      .getProjects()
      .find((item) => item.configFileName.endsWith(`${path.sep}tsconfig.json`));
    if (!project) throw new Error('打不开 tsconfig.json');
    const files = tsxFiles(path.join(root, 'src/renderer'));
    const facts = new Map<string, FileFacts>();
    const sources = new Map<string, SourceFile>();
    for (const file of files) {
      const sf = project.program.getSourceFile(file);
      if (!sf) continue;
      sources.set(file, sf);
      facts.set(
        file,
        readFacts(sf, file, (name) => project.program.getSourceFile(name))
      );
    }
    const content = path.join(root, 'src/renderer/components/settings/SettingsContent.tsx');
    const contentSf = sources.get(content);
    const contentFacts = facts.get(content);
    const seeds =
      contentSf && contentFacts
        ? pageSeeds(contentSf, contentFacts.imports)
        : new Map<string, Set<string>>();
    const byFn = propagate(seeds, facts);
    const byFile = fileCategories(byFn);
    const seeded = new Set(seeds.keys());
    expandForwarders(facts);

    const taken = new Set<string>();
    for (const fact of facts.values()) {
      for (const row of fact.rows) if (row.rowId) taken.add(row.rowId);
    }

    const categoryFor = (row: RowHit): string | null => {
      const own = row.fnKey ? byFn.get(row.fnKey) : undefined;
      if (own?.size === 1) return [...own][0] ?? null;
      const fileCats = byFile.get(row.file);
      if ((!own || own.size === 0) && fileCats?.size === 1) return [...fileCats][0] ?? null;
      if (own && own.size > 1) return null;
      return null;
    };

    const patches: Analysis['patches'] = [];
    const missing: MissingSettingsRow[] = [];
    const entries = new Map<string, SettingsSearchEntry>();
    const rows = [...facts.values()]
      .flatMap((fact) => fact.rows)
      .sort((a, b) => a.file.localeCompare(b.file) || a.pos - b.pos);

    for (const row of rows) {
      if (!row.rowId) {
        const category = categoryFor(row);
        const relative = path.relative(root, row.file);
        if (!category) {
          missing.push({
            file: relative,
            line: row.line,
            tag: row.tag,
            label: row.label ?? '',
            category: null,
          });
          continue;
        }
        const rootId = `${category}.root`;
        const preferRoot =
          row.tag === 'SettingsPage' && seeded.has(row.fnKey) && !taken.has(rootId);
        let next = preferRoot ? rootId : `${category}.${kebab(row.label ?? 'item')}`;
        if (!preferRoot) {
          const base = next;
          let n = 2;
          while (taken.has(next)) next = `${base}-${n++}`;
        }
        taken.add(next);
        patches.push({ file: row.file, insertAt: row.insertAt, id: next });
        missing.push({
          file: relative,
          line: row.line,
          tag: row.tag,
          label: row.label ?? '',
          category,
        });
        continue;
      }
      const id = row.rowId;
      const title = row.label;
      if (!title) {
        // rowId 已有、标题却是运行期动态的（如嵌入模型状态）：
        // 不进目录，但要登记，免得防漂移测试误以为它们已被收录
        missing.push({
          file: path.relative(root, row.file),
          line: row.line,
          tag: row.tag,
          label: '',
          category: categoryForSettingsRow(id),
          kind: 'dynamic',
        });
        continue;
      }
      const entry: SettingsSearchEntry = {
        id,
        category: categoryForSettingsRow(id),
        title,
        ...(row.description ? { description: row.description } : {}),
      };
      const prev = entries.get(id);
      if (!prev) {
        entries.set(id, entry);
        continue;
      }
      if (prev.title !== entry.title) {
        throw new Error(`rowId ${id} 对应了两个标题：「${prev.title}」和「${entry.title}」`);
      }
      if (entry.description && entry.description !== prev.description) {
        if (!prev.description || entry.description.length > prev.description.length) {
          entries.set(id, { ...prev, description: entry.description });
        }
      }
    }

    return {
      entries: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
      missing,
      patches,
    };
  } finally {
    api.close();
  }
}

export function extractSettingsCatalog(root = repoRoot()): SettingsCatalogExtraction {
  const { entries, missing } = analyze(root);
  return { entries, missing };
}

function writeMissingRowIds(root: string): number {
  const { patches } = analyze(root);
  const byFile = new Map<string, Array<{ insertAt: number; id: string }>>();
  for (const patch of patches) {
    const list = byFile.get(patch.file) ?? [];
    list.push(patch);
    byFile.set(patch.file, list);
  }
  for (const [file, list] of byFile) {
    const sorted = [...list].sort((a, b) => b.insertAt - a.insertAt);
    let text = readFileSync(file, 'utf8');
    for (const patch of sorted) {
      const id = patch.id.replace(/"/g, '');
      text = `${text.slice(0, patch.insertAt)} rowId="${id}"${text.slice(patch.insertAt)}`;
    }
    writeFileSync(file, text);
  }
  return patches.length;
}

function writeCatalog(root: string): SettingsCatalogExtraction {
  const extracted = extractSettingsCatalog(root);
  writeFileSync(
    path.join(root, 'src/shared/settingsCatalog.generated.ts'),
    renderSettingsCatalog(extracted.entries)
  );
  execFileSync(
    'pnpm',
    [
      'exec',
      'biome',
      'check',
      '--write',
      path.join(root, 'src/shared/settingsCatalog.generated.ts'),
    ],
    {
      cwd: root,
      stdio: 'ignore',
    }
  );
  return extracted;
}

function main() {
  const root = repoRoot();
  if (process.argv.includes('--print-ids')) {
    const { patches, missing } = analyze(root);
    for (const patch of patches) {
      console.log(`${patch.id}\t${path.relative(root, patch.file)}`);
    }
    console.log('unresolved', missing.filter((row) => !row.category).length);
    console.log(`patches ${patches.length}`);
    return;
  }
  if (process.argv.includes('--write-ids')) {
    const count = writeMissingRowIds(root);
    console.log(`wrote ${count} rowId`);
  }
  const extracted = writeCatalog(root);
  const unresolved = extracted.missing.filter((row) => !row.category);
  console.log(
    `catalog ${extracted.entries.length} entries, missing rowId ${extracted.missing.length}`
  );
  for (const row of unresolved)
    console.log(`  no category ${row.file}:${row.line} ${row.tag} ${row.label}`);
  if (unresolved.length > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
