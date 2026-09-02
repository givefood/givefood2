import { crawlCharityEw } from "../charity/crawlEw";
import { makeCharityQueueHandler } from "./charity";

export const handleCharityEwQueue = makeCharityQueueHandler("charity-ew", crawlCharityEw);
