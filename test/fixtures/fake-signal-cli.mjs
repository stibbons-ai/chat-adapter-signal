#!/usr/bin/env node
// Fake `signal-cli` executable for the spawn transport: proxies stdio to the
// FakeSignalCli line server at FAKE_SIGNAL_CLI_PORT, after announcing its
// command line. Like signal-cli it exits 0 on stdin EOF; when the server drops
// the connection it exits 3 with an error on stderr. FAKE_SIGNAL_CLI_FAIL=<text>
// makes it print <text> to stderr and exit 1 at once, as signal-cli does for an
// unregistered account.
import { connect } from "node:net";

if (process.env.FAKE_SIGNAL_CLI_FAIL) {
  process.stderr.write(`${process.env.FAKE_SIGNAL_CLI_FAIL}\n`);
  process.exit(1);
}
const socket = connect(Number(process.env.FAKE_SIGNAL_CLI_PORT), "127.0.0.1");
socket.write(`${JSON.stringify({ fakeArgv: process.argv.slice(2), pid: process.pid })}\n`);
process.stdin.pipe(socket);
socket.pipe(process.stdout);
process.stdin.on("end", () => process.exit(0));
socket.on("error", () => {});
socket.on("close", () => {
  process.stderr.write("ERROR fake signal-cli: lost connection to the daemon\n");
  process.exit(3);
});
