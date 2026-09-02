import { crawlCharityScotland } from "../charity/crawlScotland";
import { makeCharityQueueHandler } from "./charity";

export const handleCharityScotlandQueue = makeCharityQueueHandler("charity-scotland", crawlCharityScotland);
