// #3750: the one definition of how long a shopper's message to an assistant may be, read by the
// Worker (which refuses a longer one) and by the assistant window (which stops the box at it and
// says so), so the box can never accept a message the server will then refuse.
export const SHOPPER_MESSAGE_MAX_CHARS = 280;
