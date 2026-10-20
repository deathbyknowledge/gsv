export const WAKING_UP = "Ship is waking up";

/**
 * What a new owner reads while their Ship has not said anything yet: from dismissing the welcome card,
 * through the first run's thinking, until the first message lands. The dots walk and the line breathes
 * so the wait does not look frozen; both hold still under reduced motion.
 */
export function WakingUp() {
  return <p class="zen-waking" role="status" aria-label={`${WAKING_UP}…`}>
    <span aria-hidden="true">{WAKING_UP}</span>
    <span class="zen-waking-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
  </p>;
}
