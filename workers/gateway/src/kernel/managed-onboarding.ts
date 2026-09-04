import type {
  RequestFrame,
} from "../protocol/frames";
import type {
  InstallationOnboardingAuthorization,
  SysSetupResult,
} from "@humansandmachines/gsv/protocol";
import {
  ensureKernelBootstrapped,
} from "./connect";
import type {
  KernelContext,
} from "./context";
import {
  handleSysSetup as handleKernelSetup,
  recoverCompletedSysSetup,
} from "./sys/setup";
import {
  handleSysSetupAssist,
} from "./sys/setup-assist";
import {
  managedInstallationWorkGate,
} from "../installation/lifecycle";
import type {
  GatewayEnv,
} from "../runtime-env";
import {
  KernelConnection,
  type KernelConnectionState as ConnectionState,
} from "./connection";
import type { Kernel } from "./do";
import {
  MANAGED_ONBOARDING_COMPLETION_KEY,
} from "./do-shared";
import type {
  PendingManagedOnboardingCompletion,
} from "./do-shared";


export class ManagedOnboarding {
  constructor(readonly host: Kernel) {}

managedOnboardingInProgress = false;

pendingManagedOnboarding?: PendingManagedOnboardingCompletion;

async handleSysSetup(
    connection: KernelConnection<ConnectionState>,
    frame: RequestFrame<"sys.setup">,
  ): Promise<void> {
    const state = connection.state;
    if (state && state.step !== "pending") {
      this.host.transport.sendError(
        connection,
        frame.id,
        409,
        state.step === "superseded" ? "Connection replaced" : "Already connected",
      );
      return;
    }

    const ctx = this.host.buildContext(connection);
    await ensureKernelBootstrapped(ctx);

    if (this.managedOnboardingService()) {
      await this.handleManagedSysSetup(connection, frame, ctx);
      return;
    }

    if (!this.host.auth.isSetupMode()) {
      this.host.transport.sendError(connection, frame.id, 409, "System already initialized");
      return;
    }

    try {
      const data = await handleKernelSetup(frame.args, ctx);
      this.host.transport.sendOk(connection, frame.id, data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.transport.sendError(connection, frame.id, 400, message);
    }
  }

async handleSysSetupAssist(
    connection: KernelConnection<ConnectionState>,
    frame: RequestFrame<"sys.setup.assist">,
  ): Promise<void> {
    const state = connection.state;
    if (state && state.step !== "pending") {
      this.host.transport.sendError(
        connection,
        frame.id,
        409,
        state.step === "superseded" ? "Connection replaced" : "Already connected",
      );
      return;
    }

    const ctx = this.host.buildContext(connection);
    await ensureKernelBootstrapped(ctx);

    let args = frame.args;
    if (this.managedOnboardingService()) {
      let authorization: InstallationOnboardingAuthorization;
      try {
        authorization = await this.authorizeManagedInstallationOnboarding(
          frame.args.onboardingToken,
        );
      } catch {
        this.host.transport.sendError(connection, frame.id, 503, "Installation setup is unavailable");
        return;
      }
      if (!authorization.ok) {
        this.host.transport.sendError(
          connection,
          frame.id,
          401,
          "Installation setup link is invalid or expired",
        );
        return;
      }
      const { onboardingToken: _onboardingToken, ...assistArgs } = frame.args;
      args = assistArgs;
    }

    if (!this.host.auth.isSetupMode()) {
      this.host.transport.sendError(connection, frame.id, 409, "System already initialized");
      return;
    }

    try {
      const data = await handleSysSetupAssist(args, ctx);
      this.host.transport.sendOk(connection, frame.id, data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.transport.sendError(connection, frame.id, 400, message);
    }
  }

async handleManagedSysSetup(
    connection: KernelConnection<ConnectionState>,
    frame: RequestFrame<"sys.setup">,
    ctx: KernelContext,
  ): Promise<void> {
    if (this.managedOnboardingInProgress) {
      this.host.transport.sendError(connection, frame.id, 409, "Installation setup is already in progress");
      return;
    }
    this.managedOnboardingInProgress = true;

    try {
      const { onboardingToken: _onboardingToken, ...setupArgs } = frame.args;
      let authorization: InstallationOnboardingAuthorization;
      try {
        authorization = await this.authorizeManagedInstallationOnboarding(
          frame.args.onboardingToken,
        );
      } catch {
        this.host.transport.sendError(connection, frame.id, 503, "Installation setup is unavailable");
        return;
      }
      if (!authorization.ok) {
        let recovered: SysSetupResult | null;
        try {
          recovered = await this.recoverActivatedManagedSetup(setupArgs);
        } catch {
          this.host.transport.sendError(connection, frame.id, 503, "Installation setup is unavailable");
          return;
        }
        if (recovered) {
          this.host.transport.sendOk(connection, frame.id, recovered);
          return;
        }
        this.host.transport.sendError(
          connection,
          frame.id,
          401,
          "Installation setup link is invalid or expired",
        );
        return;
      }

      let data: SysSetupResult;
      try {
        if (this.host.auth.isSetupMode()) {
          data = await handleKernelSetup(setupArgs, ctx);
        } else {
          const pending = this.pendingManagedOnboarding;
          if (
            pending
            && (
              pending.claimId !== authorization.claimId
              || pending.installationId !== authorization.installation.installationId
            )
          ) {
            throw new Error("System already initialized");
          }
          data = await recoverCompletedSysSetup(setupArgs, ctx);
        }
        this.pendingManagedOnboarding = {
          claimId: authorization.claimId,
          installationId: authorization.installation.installationId,
        };
        this.host.ctx.storage.kv.put(
          MANAGED_ONBOARDING_COMPLETION_KEY,
          this.pendingManagedOnboarding,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.host.transport.sendError(connection, frame.id, 400, message);
        return;
      }

      try {
        const directory = this.managedOnboardingService();
        if (!directory) throw new Error("Managed onboarding is unavailable");
        const completion = await directory.completeInstallationOnboarding({
          claimId: authorization.claimId,
          installationId: authorization.installation.installationId,
        });
        if (
          completion.state !== "complete"
          || completion.installationId !== authorization.installation.installationId
        ) {
          throw new Error("Installation onboarding completion mismatch");
        }
        this.pendingManagedOnboarding = undefined;
        this.host.ctx.storage.kv.delete(MANAGED_ONBOARDING_COMPLETION_KEY);
        this.host.transport.sendOk(connection, frame.id, data);
      } catch {
        this.host.transport.sendError(
          connection,
          frame.id,
          503,
          "Installation setup could not be activated",
        );
      }
    } finally {
      this.managedOnboardingInProgress = false;
    }
  }

async authorizeManagedInstallationOnboarding(
    token: string | undefined,
  ): Promise<InstallationOnboardingAuthorization> {
    if (!token) return { ok: false };
    const directory = this.managedOnboardingService();
    const installation = this.host.installationIdentity;
    if (!directory || !installation) return { ok: false };

    const authorization = await directory.authorizeInstallationOnboarding({
      installationId: installation.installationId,
      token,
    });
    if (
      !authorization.ok
      || authorization.installation.installationId !== installation.installationId
      || authorization.installation.handle !== installation.handle
      || authorization.installation.canonicalOrigin !== installation.canonicalOrigin
    ) {
      return { ok: false };
    }
    return authorization;
  }

async recoverActivatedManagedSetup(
    args: Parameters<typeof recoverCompletedSysSetup>[0],
  ): Promise<SysSetupResult | null> {
    const pending = this.pendingManagedOnboarding;
    const installation = this.host.installationIdentity;
    const directory = this.managedOnboardingService();
    if (!pending || !installation || !directory || this.host.auth.isSetupMode()) {
      return null;
    }

    const resolved = await directory.resolveHostname(
      new URL(installation.canonicalOrigin).hostname,
    );
    if (
      !resolved.found
      || resolved.state !== "active"
      || resolved.installationId !== installation.installationId
      || resolved.handle !== installation.handle
      || resolved.canonicalOrigin !== installation.canonicalOrigin
    ) {
      return null;
    }

    let data: SysSetupResult;
    try {
      data = await recoverCompletedSysSetup(args, this.host.buildKernelContext({}));
    } catch {
      return null;
    }
    this.pendingManagedOnboarding = undefined;
    this.host.ctx.storage.kv.delete(MANAGED_ONBOARDING_COMPLETION_KEY);
    return data;
  }

managedOnboardingService(): GatewayEnv["INSTALLATION_DIRECTORY"] | null {
    return this.host.env.INSTALLATION_DIRECTORY ?? null;
  }

async managedWorkGate() {
    return await managedInstallationWorkGate(
      this.host.env,
      this.host.installationId,
    );
  }
}
