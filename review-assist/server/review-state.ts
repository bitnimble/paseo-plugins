import { type ReviewState, type StateChange, reviewStateSchema } from "../shared/protocol";
import { EMPTY_REVIEW_STATE, applyStateChange } from "../shared/review-state";
import { JsonSlots, type Target, targetSlot } from "./slots";

export class ReviewStates {
  private readonly slots: JsonSlots<ReviewState>;

  constructor(directory: string) {
    this.slots = new JsonSlots(directory, reviewStateSchema);
  }

  async read(target: Target): Promise<ReviewState> {
    return (await this.slots.read(slotOf(target))) ?? EMPTY_REVIEW_STATE;
  }

  apply(target: Target, change: StateChange): Promise<ReviewState> {
    return this.slots.update(slotOf(target), (current) => applyStateChange(current ?? EMPTY_REVIEW_STATE, change));
  }
}

function slotOf(target: Target): string {
  return `${targetSlot(target)}.state`;
}
