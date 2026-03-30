export const BUILTIN_DOCTOR_SOURCE = [
  "import { WorkerEntrypoint } from \"cloudflare:workers\";",
  "",
  "export default class DoctorCommand extends WorkerEntrypoint {",
  "  async run() {",
  "    return {",
  "      exitCode: 0,",
  "      stdout: \"gsv doctor: status checks are not implemented yet\\n\",",
  "      stderr: \"\",",
  "    };",
  "  }",
  "}",
].join("\n");
