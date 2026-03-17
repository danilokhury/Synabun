const WebSocket = require('ws');
console.log('Connecting to ws://localhost:3344/ws/claude-skin ...');

const ws = new WebSocket('ws://localhost:3344/ws/claude-skin');

ws.on('open', () => {
  console.log('[open] Connected');
  ws.send(JSON.stringify({
    type: 'query',
    prompt: 'Say exactly: hello world',
    cwd: 'J:/Sites/Apps/Synabun'
  }));
  console.log('[sent] query');
});

ws.on('message', (data) => {
  const str = data.toString();
  const msg = JSON.parse(str);
  if (msg.type === 'event') {
    console.log('[event]', msg.event.type, JSON.stringify(msg.event).substring(0, 150));
  } else {
    console.log('[' + msg.type + ']', str.substring(0, 200));
  }
});

ws.on('error', (err) => {
  console.log('[error]', err.message);
  process.exit(1);
});

ws.on('close', (code, reason) => {
  console.log('[close]', code);
  process.exit(0);
});

setTimeout(() => {
  console.log('[timeout] 25s elapsed');
  process.exit(1);
}, 25000);
