import { crawlOpenCharities } from "../charity/crawlOpenCharities";
import { makeCharityQueueHandler } from "./charity";

// Still three queues, one crawler. The per-country split now buys only
// retry isolation -- a stuck Scottish message cannot hold up E&W's batch --
// which is worth keeping even though every one of them calls the same
// opencharities.uk endpoint. See charity/crawlOpenCharities.ts.
export const handleCharityScotlandQueue = makeCharityQueueHandler("charity-scotland", crawlOpenCharities);
