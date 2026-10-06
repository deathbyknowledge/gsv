import type { GSVClient } from "@humansandmachines/gsv/client";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  APPROVAL_CATEGORIES,
  composeApprovalChoices,
  currentApprovalChoices,
  type ApprovalCategoryId,
  type ApprovalChoice,
  type ApprovalChoices,
  type ApprovalPolicyValue,
} from "../../../domain/agentApproval";
import { normalizedApprovalPolicy, parseApprovalPolicy, serializeApprovalPolicy } from "../../../domain/system/consoleAgentBehavior";
import { saveAccountApprovalPolicy, type ApprovalPolicySource } from "../../../services/system/approvalPolicyService";

/** Where the explanation stands: the Ship's word and its question, the list with per-kind picks, or why nothing can change. */
export type ApprovalSetupStage = "ask" | "detail" | "blocked" | "why";

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
  /** Called with the policy that was written, so cached config reads catch up and the pending request can follow it;
   *  null after a failed write, so the snapshot reloads without anything having changed. */
  onSaved: (policy: string | null) => Promise<void>;
};

export type ApprovalSetupState = {
  stage: ApprovalSetupStage | null;
  /** The stage's second part (the box after a Ship message, or the Ship's answer after "why?") has had its reading pause. */
  revealed: boolean;
  choices: ApprovalChoices;
  saving: boolean;
  error: string | null;
  /** Open the explanation; a no-op while it is already open. */
  show: () => void;
  /** Every kind the Ship asks about becomes allowed. */
  allowAll: () => void;
  /** Everything is allowed except deleting and contacting someone. */
  limit: () => void;
  /** List what the Ship asks about, with a pick for each. */
  detail: () => void;
  choose: (id: ApprovalCategoryId, choice: ApprovalChoice) => void;
  /** Write the picks made on the list. */
  save: () => void;
  /** Say why this account cannot change the rules. */
  why: () => void;
  close: () => void;
};

const KEEP_ASKING: readonly ApprovalCategoryId[] = ["delete", "mail"];

/** How long the person gets to read the Ship's message before what follows it appears. */
const READING_PAUSE_MS = { ask: 2400, detail: 2000, why: 700, blocked: 0 } satisfies Record<ApprovalSetupStage, number>;

function everyCategory(choice: (id: ApprovalCategoryId) => ApprovalChoice): ApprovalChoices {
  const picks: ApprovalChoices = {};
  for (const category of APPROVAL_CATEGORIES) picks[category.id] = choice(category.id);
  return picks;
}

/** The explanation's stage machine: opens on request beside a pending approval, writes the policy, then closes. */
export function useApprovalSetup({ client, policyUid, pending, editable, inherited, override, inheritedSource, onSaved }: ApprovalSetupInput): ApprovalSetupState {
  const [stage, setStage] = useState<ApprovalSetupStage | null>(null);
  const [choices, setChoices] = useState<ApprovalChoices>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const savingRef = useRef(saving);
  savingRef.current = saving;

  /* a message lands first and its box follows, as the Ship would pace it */
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (stage === null) return;
    const pause = READING_PAUSE_MS[stage];
    if (pause === 0) { setRevealed(true); return; }
    setRevealed(false);
    const timer = setTimeout(() => setRevealed(true), pause);
    return () => clearTimeout(timer);
  }, [stage]);

  /* the explanation belongs to the pending approval: once that is answered or expires, an unfinished one closes */
  useEffect(() => {
    if (!pending && stage !== null && !saving) setStage(null);
  }, [pending, saving, stage]);

  const show = useCallback(() => {
    if (stageRef.current !== null || !pending) return;
    setChoices({});
    setError(null);
    setStage(editable ? "ask" : "blocked");
  }, [editable, pending]);

  const close = useCallback(() => {
    if (savingRef.current) return;
    setStage(null);
  }, []);

  const detail = useCallback(() => { if (stageRef.current === "ask") { setError(null); setStage("detail"); } }, []);
  const why = useCallback(() => { if (stageRef.current === "blocked") setStage("why"); }, []);

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

  /* composed against the current snapshot: after a failed save that snapshot is reloaded, so revised picks compose against what is saved now */
  const write = useCallback((picks: ApprovalChoices) => {
    if (savingRef.current || policyUid === null) return;
    const base: ApprovalPolicyValue | null = override ? parseApprovalPolicy(override) : null;
    const next = serializeApprovalPolicy(composeApprovalChoices(parseApprovalPolicy(inherited), base, picks));
    if (normalizedApprovalPolicy(next) === normalizedApprovalPolicy(override || inherited)) { setStage(null); return; }
    setSaving(true);
    setError(null);
    void (async () => {
      try {
        await saveAccountApprovalPolicy(client, policyUid, override, next, inheritedSource);
        await onSaved(next);
      } catch (failure) {
        await onSaved(null).catch(() => {});
        setError(failure instanceof Error ? failure.message : "The policy did not save.");
        setSaving(false);
        return;
      }
      setSaving(false);
      setStage(null);
    })();
  }, [client, inherited, inheritedSource, onSaved, override, policyUid]);

  const allowAll = useCallback(() => {
    if (stageRef.current !== "ask") return;
    write(everyCategory(() => "auto"));
  }, [write]);
  const limit = useCallback(() => {
    if (stageRef.current !== "ask") return;
    write(everyCategory((id) => KEEP_ASKING.includes(id) ? "ask" : "auto"));
  }, [write]);
  const save = useCallback(() => {
    if (stageRef.current !== "detail") return;
    write(choices);
  }, [choices, write]);

  return { stage, revealed, choices, saving, error, show, allowAll, limit, detail, choose, save, why, close };
}
