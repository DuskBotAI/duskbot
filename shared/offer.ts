// A suggestion dusk bot makes on its own: one find about something the person is working toward, and one offer to have
// a bot prepare work for it.

export type OfferAnswer = "do" | "notNow" | "never";

export interface OfferCard {
  /** The suggestion's id: `POST /api/offers/answer` takes it with the message's thread and id. */
  id: string;
  /** The bot that would do the work, as it was named when the offer was made. */
  botName: string;
  /** What that bot would do, in a few words ("Prep a shortlist of the best roles"). */
  action: string;
  answer?: OfferAnswer;
  /** Do it: the conversation the work went to. */
  started?: { botId: string; threadId: string };
}

/** On a bot's line the server posted (`serverCard`): its `text` is the find and the offer for every client, and replays
 * to a model only as records. Clients that know this field draw Do it, Not now and Don't suggest this under it. */
export interface OfferField {
  offer?: OfferCard;
}
