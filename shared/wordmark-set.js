// #3781 (part of #3771): the one definition of which wordmark lettering styles
// and colour pairs a landlet may choose, read by the Worker (which refuses any
// other id) and by the client picker (which offers only these). Ids only: the
// faces and colours themselves belong to the renderer (#3782). The owner's pick
// from the lettering page (#3780) is added here, in one place.
export const DEFAULT_WORDMARK_ID = 'default';
export const WORDMARK_STYLE_IDS = [DEFAULT_WORDMARK_ID];
export const WORDMARK_COLOR_IDS = [DEFAULT_WORDMARK_ID];

export function isWordmarkStyleId(id) {
  return WORDMARK_STYLE_IDS.includes(id);
}
export function isWordmarkColorId(id) {
  return WORDMARK_COLOR_IDS.includes(id);
}
