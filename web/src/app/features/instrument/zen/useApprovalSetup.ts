import type { GSVClient } from "@humansandmachines/gsv/client";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  composeApprovalChoices,
  currentApprovalChoices,
  type ApprovalCategoryId,
  type ApprovalChoice,
  type ApprovalChoices,
  type ApprovalPolicyValue,
} from "../../../domain/agentApproval";
import { normalizedApprovalPolicy, parseApprovalPolicy, serializeApprovalPolicy } from "../../../domain/system/consoleAgentBehavior";
import { saveAccountApprovalPolicy, type ApprovalPolicySource } from "../../../services/system/approvalPolicyService";

type Stage = "idle" | "step1" | "step2" | "saving";

export type ApprovalSetupInput = {
  client: Pick<GSVClient, "sys">;
  /** The account whose policy the pending process resolves; its override is what the choices write. */
  policyUid: number | null;
  /** An approval is pending; once nothing is, an open explanation closes without recording anything. */
  pending: boolean;
  editable: boolean;
  /** The policy the account inherits, and its own override if it has one. */
  inherited: string;
  override: string;
  /** The raw inherited source the snapshot was read from, so a save refuses a newer one. */
  inheritedSource: ApprovalPolicySource;
  /** Called after the policy is written, so cached config reads catch up. */
  onSaved: () => Promise<void>;
};

export type ApprovalSetupState = {
  open: boolean;
  step: 1 | 2;
  choices: ApprovalChoices;
  saving: boolean;
  error: string | null;
  /** Open the explanation at its first step; a no-op while it is already open. */
  show: () => void;
  choose: (id: ApprovalCategoryId, choice: ApprovalChoice) => void;
  continueFlow: () => void;
  close: () => void;
};

/** The explanation's stage machine: opens on request beside a pending approval, writes the policy, then closes. */
export function useApprovalSetup({ client, policyUid, pending, editable, inherited, override, inheritedSource, onSaved }: ApprovalSetupInput): ApprovalSetupState {
  const [stage, setStage] = useState<Stage>("idle");
  const [choices, setChoices] = useState<ApprovalChoices>({});
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef(stage);
  stageRef.current = stage;

  /* the explanation belongs to the pending approval: once that is answered or expires, an unfinished one closes */
  useEffect(() => {
    if (!pending && stage !== "idle" && stage !== "saving") setStage("idle");
  }, [pending, stage]);

  const show = useCallback(() => {
    if (stageRef.current !== "idle" || !pending) return;
    setChoices({});
    setError(null);
    setStage("step1");
  }, [pending]);

  const close = useCallback(() => {
    if (stageRef.current === "saving") return;
    setStage("idle");
  }, []);

  /* picking what the policy already does is not a choice, so unchanged picks write no override */
  const choose = useCallback((id: ApprovalCategoryId, choice: ApprovalChoice) => {
    const base = parseApprovalPolicy(override || inherited);
    const unchanged = currentApprovalChoices(base)[id] === choice;
    setChoices((current) => {
      const next = { ...current };
      if (unchanged) delete next[id]; else next[id] = choice;
      return next;
    });
    setError(null);
  }, [inherited, override]);

  const continueFlow = useCallback(() => {
    const current = stageRef.current;
    if (current === "step1") {
      if (!editable) { setStage("idle"); return; }
      setStage("step2");
      return;
    }
    if (current !== "step2" || policyUid === null) return;
    /* composed against the current snapshot: after a failed save that snapshot is reloaded, so revised picks compose against what is saved now */
    const base: ApprovalPolicyValue | null = override ? parseApprovalPolicy(override) : null;
    const next = serializeApprovalPolicy(composeApprovalChoices(parseApprovalPolicy(inherited), base, choices));
    if (normalizedApprovalPolicy(next) === normalizedApprovalPolicy(override || inherited)) { setStage("idle"); return; }
    setStage("saving");
    setError(null);
    void (async () => {
      try {
        await saveAccountApprovalPolicy(client, policyUid, override, next, inheritedSource);
        await onSaved();
      } catch (failure) {
        await onSaved().catch(() => {});
        setError(failure instanceof Error ? failure.message : "The policy did not save.");
        setStage("step2");
        return;
      }
      setStage("idle");
    })();
  }, [choices, client, editable, inherited, inheritedSource, onSaved, override, policyUid]);

  return {
    open: stage !== "idle",
    step: stage === "step1" ? 1 : 2,
    choices,
    saving: stage === "saving",
    error,
    show,
    choose,
    continueFlow,
    close,
  };
}
