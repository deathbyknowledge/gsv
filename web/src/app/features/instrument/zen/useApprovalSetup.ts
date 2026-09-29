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
import { markApprovalSetup, saveAccountApprovalPolicy, type ApprovalPolicySource } from "../../../services/system/approvalPolicyService";

type Stage = "idle" | "step1" | "step2" | "saving" | "done";

export type ApprovalSetupInput = {
  client: Pick<GSVClient, "sys">;
  /** The signed-in account, which owns the walkthrough mark. */
  uid: number | null;
  /** The account whose policy the pending process resolves; its override is what the choices write. */
  policyUid: number | null;
  /** The card should open: an approval is pending and the account has not done or skipped the walkthrough. */
  due: boolean;
  /** Nothing is pending any more; an unfinished card closes without recording anything. */
  pending: boolean;
  editable: boolean;
  /** The policy the account inherits, and its own override if it has one. */
  inherited: string;
  override: string;
  /** The raw inherited source the snapshot was read from, so a save refuses a newer one. */
  inheritedSource: ApprovalPolicySource;
  /** Called after either key is written, so cached config reads catch up. */
  onSaved: () => Promise<void>;
};

export type ApprovalSetupState = {
  open: boolean;
  step: 1 | 2;
  choices: ApprovalChoices;
  saving: boolean;
  error: string | null;
  choose: (id: ApprovalCategoryId, choice: ApprovalChoice) => void;
  continueFlow: () => void;
  skip: () => void;
};

/** The walkthrough's stage machine: opens once per pending approval while due, writes the policy then the mark. */
export function useApprovalSetup({ client, uid, policyUid, due, pending, editable, inherited, override, inheritedSource, onSaved }: ApprovalSetupInput): ApprovalSetupState {
  const [stage, setStage] = useState<Stage>("idle");
  const [choices, setChoices] = useState<ApprovalChoices>({});
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  /* an account that cannot write the mark still acknowledged the walkthrough: keep that for the session */
  const acknowledgedRef = useRef(false);

  /* opens when an approval is pending and the mark is unset; once nothing is pending, whatever stage it reached is
     forgotten, so the next approval reads the mark afresh (show it again in Settings clears it) */
  useEffect(() => {
    if (stage === "idle" && due && pending && !acknowledgedRef.current) {
      setChoices({});
      setError(null);
      setStage("step1");
    } else if (!pending && stage !== "idle" && stage !== "saving") {
      setStage("idle");
    }
  }, [due, pending, stage]);

  const finish = useCallback(async (mark: "done" | "skipped") => {
    if (uid === null) { acknowledgedRef.current = true; setStage("done"); return; }
    setStage("saving");
    setError(null);
    try {
      await markApprovalSetup(client, uid, mark);
      await onSaved();
      setStage("done");
    } catch (failure) {
      /* the policy may already be written: reload so a retry composes against what is saved now */
      await onSaved().catch(() => {});
      setError(failure instanceof Error ? failure.message : "The mark did not save.");
      setStage("step2");
    }
  }, [client, onSaved, uid]);

  /* picking what the policy already does is not a choice, so an unchanged walkthrough writes no override */
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
      if (!editable) { acknowledgedRef.current = true; setStage("done"); return; }
      setStage("step2");
      return;
    }
    if (current !== "step2" || uid === null || policyUid === null) return;
    const picked = Object.keys(choices).length > 0;
    if (!picked) { void finish("done"); return; }
    /* composed against the current snapshot: after a partial save that snapshot is the written policy,
       so unchanged picks write only the mark and revised picks write again */
    const base: ApprovalPolicyValue | null = override ? parseApprovalPolicy(override) : null;
    const next = serializeApprovalPolicy(composeApprovalChoices(parseApprovalPolicy(inherited), base, choices));
    if (normalizedApprovalPolicy(next) === normalizedApprovalPolicy(override || inherited)) { void finish("done"); return; }
    setStage("saving");
    setError(null);
    void (async () => {
      try {
        await saveAccountApprovalPolicy(client, policyUid, override, next, inheritedSource);
      } catch (failure) {
        await onSaved().catch(() => {});
        setError(failure instanceof Error ? failure.message : "The policy did not save.");
        setStage("step2");
        return;
      }
      await finish("done");
    })();
  }, [choices, client, editable, finish, inherited, inheritedSource, onSaved, override, policyUid, uid]);

  const skip = useCallback(() => {
    const current = stageRef.current;
    if (current !== "step1" && current !== "step2") return;
    void finish("skipped");
  }, [finish]);

  return {
    open: stage === "step1" || stage === "step2" || stage === "saving",
    step: stage === "step1" ? 1 : 2,
    choices,
    saving: stage === "saving",
    error,
    choose,
    continueFlow,
    skip,
  };
}
