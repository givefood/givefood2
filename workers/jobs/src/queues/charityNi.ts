import { crawlCharityNi } from "../charity/crawlNi";
import { makeCharityQueueHandler } from "./charity";

export const handleCharityNiQueue = makeCharityQueueHandler("charity-ni", crawlCharityNi);
