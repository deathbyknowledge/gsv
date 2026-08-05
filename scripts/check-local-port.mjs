import net from "node:net";

const port = Number(process.argv[2]);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("local development port is invalid");
}

const server = net.createServer();
server.once("error", (error) => {
  if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
    process.stderr.write(`Port ${port} is already in use; stop that service before starting managed GSV.\n`);
    process.exitCode = 1;
    return;
  }
  throw error;
});
server.listen(port, "127.0.0.1", () => server.close());
