const readline = require("node:readline");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        ok: true,
        supportedMethods: ["environmentExecute"],
      },
    });
    return;
  }

  if (method === "environmentExecute") {
    const delayMs = Number(message.params?.delayMs ?? 0);
    const progressIntervalMs = Number(message.params?.progressIntervalMs ?? 0);
    let progressTimer = null;
    if (progressIntervalMs > 0) {
      const providerLeaseId = message.params?.lease?.providerLeaseId;
      const companyId = message.params?.companyId;
      progressTimer = setInterval(() => {
        send({
          jsonrpc: "2.0",
          method: "streams.emit",
          params: {
            channel: providerLeaseId ? `environment-execute:${providerLeaseId}` : "",
            companyId,
            event: {
              stream: "stdout",
              chunk: "progress\n",
            },
          },
        });
      }, progressIntervalMs);
    }
    setTimeout(() => {
      if (progressTimer) clearInterval(progressTimer);
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "ok\n",
          stderr: "",
        },
      });
    }, delayMs);
    return;
  }

  if (method === "shutdown") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {},
    });
    setImmediate(() => process.exit(0));
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32601,
      message: `Unhandled method: ${method}`,
    },
  });
});
