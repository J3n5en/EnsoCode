/** 真实 MCP 工具里出现过、Gemini 会整单拒绝的写法合集 */
export const MCP_SCHEMA_ZOO = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    path: { type: 'string' },
    limit: { type: ['number', 'null'] },
    ids: { type: 'array', items: { type: 'string' }, uniqueItems: true, contains: { const: 'a' } },
    mode: { const: 'fast' },
    tags: { type: 'object', propertyNames: { pattern: '^a' }, additionalProperties: true },
    node: { $ref: '#/$defs/Node' },
  },
  required: ['path'],
  if: { properties: { mode: { const: 'fast' } } },
  // biome-ignore lint/suspicious/noThenProperty: JSON Schema 条件关键字
  then: { required: ['limit'] },
  dependentRequired: { limit: ['path'] },
  $defs: { Node: { type: 'object', properties: { id: { type: 'string' } } } },
};
