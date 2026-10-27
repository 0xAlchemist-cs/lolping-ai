import { createInterface } from 'node:readline';

const mode = process.argv[2];
if (mode === 'hang') setInterval(() => undefined, 1000);
else {
  const lines = createInterface({ input: process.stdin });
  lines.once('line', (line) => {
    lines.close();
    if (mode === 'invalid') process.stdout.write('{"type":"result","status":"unknown"}\n');
    else if (mode === 'large') process.stdout.write('x'.repeat(8192));
    else if (mode === 'fail') {
      process.stdout.write('{"type":"result","status":"error","code":"osError","win32":5}\n');
      process.exitCode = 1;
    } else {
      const request = JSON.parse(line);
      const status = request.type === 'activate' ? 'launchRequired'
        : request.type === 'flushComposition' ? 'compositionFlushed'
          : request.type === 'styleWindow' ? 'frameStyled' : 'desktopShown';
      process.stdout.write(JSON.stringify({ type: 'result', status }) + '\n');
    }
  });
}
