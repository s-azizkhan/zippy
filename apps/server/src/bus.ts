import { EventEmitter } from "node:events";
import type { TicketEvent } from "@zippy/shared";

export const bus = new EventEmitter().setMaxListeners(0);

export const emit = (ticketId: string, event: TicketEvent) => bus.emit(ticketId, event);
