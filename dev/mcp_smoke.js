// MCP 서버 스모크 테스트: stdio로 붙어 도구 목록과 search_mail / get_mail / backup_stats 호출
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
(async () => {
  const transport = new StdioClientTransport({ command: 'node', args: [require('path').join(__dirname, '..', 'mcp', 'server.js')], env: { ...process.env, MAIL_BACKUP_FIXTURE: require('path').join(__dirname, 'fixtures', 'index.json') }, stderr: 'pipe' });
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(transport);
  const tools = await client.listTools();
  console.log('tools:', tools.tools.map(t => t.name).join(', '));
  const s = await client.callTool({ name: 'search_mail', arguments: { query: '계약서 has:attachment', limit: 5 } });
  const sr = JSON.parse(s.content[0].text); console.log('search total', sr.total, 'first', sr.items[0] && sr.items[0].subject, 'atts', sr.items[0] && sr.items[0].attachments.map(a => a.name));
  const g = await client.callTool({ name: 'get_mail', arguments: { id: sr.items[0].id } });
  const gr = JSON.parse(g.content[0].text); console.log('body starts:', gr.body.slice(0, 30).replace(/\n/g, ' '));
  const st = await client.callTool({ name: 'backup_stats', arguments: {} });
  console.log('stats total', JSON.parse(st.content[0].text).total);
  const l = await client.callTool({ name: 'list_labels', arguments: {} });
  console.log('labels', JSON.parse(l.content[0].text).labels.length);
  const a = await client.callTool({ name: 'get_attachment_text', arguments: { fileId: 'X' } });
  console.log('attachment in fixture mode ->', a.isError ? 'error as expected' : 'unexpected');
  await client.close();
})().catch(e => { console.error('SMOKE FAIL', e); process.exit(1); });
