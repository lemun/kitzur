// Built-in stop words for the supersession rule (DESIGN.md, ), shipped as data.
//
// Content words are lower-cased runs of 3+ Unicode letters or digits (/[\p{L}\p{N}]{3,}/gu), so words of
// one or two letters never need listing. `ledger.stopWords` extends these lists; nothing here is code.
//
// The English list is a standard function-word list plus the conversational filler that the review's
// measured probe used (tmp/review-consolidate/supersede2.py STOP: "use", "please", "make", "just", ...).
// The Hebrew list holds common function words, pronouns and fillers (3+ letters; prefixed forms such as
// "שהוא" are listed where they are frequent).

/** English stop words (lower case, 3+ letters). */
export const ENGLISH_STOP_WORDS: readonly string[] = [
  // articles, pronouns, determiners
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'yours', 'yourself', 'yourselves', 'all', 'any', 'can',
  'had', 'her', 'hers', 'herself', 'him', 'himself', 'his', 'was', 'one', 'our', 'ours', 'ourselves', 'out', 'has',
  'have', 'having', 'this', 'that', 'these', 'those', 'with', 'from', 'they', 'them', 'themselves', 'their',
  'theirs', 'will', 'would', 'there', 'what', 'about', 'which', 'when', 'where', 'who', 'whom', 'whose', 'why',
  'how', 'its', 'itself', 'myself', 'she', 'were', 'been', 'being', 'does', 'did', 'doing', 'done', 'into',
  'onto', 'upon', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'both', 'each', 'few', 'more',
  'most', 'other', 'others', 'some', 'such', 'nor', 'only', 'own', 'same', 'than', 'too', 'very', 'should',
  'could', 'must', 'may', 'might', 'shall', 'ought', 'now', 'also', 'just', 'yet', 'still', 'even', 'ever',
  'every', 'either', 'neither', 'whether', 'while', 'because', 'since', 'until', 'unless', 'though', 'although',
  'during', 'before', 'after', 'above', 'below', 'between', 'through', 'against', 'among', 'within', 'without',
  'across', 'along', 'around', 'off', 'down', 'via', 'per',
  // contractions without apostrophes (tokenization splits at the apostrophe: "don't" -> "don")
  'don', 'doesn', 'didn', 'isn', 'aren', 'wasn', 'weren', 'hasn', 'haven', 'hadn', 'won', 'wouldn', 'shouldn',
  'couldn', 'mustn', 'cannot', 'let', 'lets', 'll', 've',
  // conversational filler (supersede2.py STOP)
  'like', 'time', 'know', 'take', 'year', 'see', 'come', 'think', 'look', 'want', 'give', 'day', 'use', 'two',
  'first', 'well', 'way', 'new', 'work', 'back', 'make', 'please', 'okay', 'yes', 'thanks', 'thank', 'sure',
  'maybe', 'really', 'something', 'anything', 'everything', 'nothing', 'thing', 'things', 'get', 'got', 'put',
  'need', 'needs', 'going', 'able',
];

/** Hebrew stop words (3+ letters). */
export const HEBREW_STOP_WORDS: readonly string[] = [
  // pronouns
  'אני', 'אתה', 'אנחנו', 'אתם', 'אתן', 'הוא', 'היא', 'הם', 'הן', 'אותו', 'אותה', 'אותם', 'אותן', 'אותי', 'אותך',
  'אותנו', 'שלי', 'שלך', 'שלו', 'שלה', 'שלנו', 'שלכם', 'שלהם', 'שלהן', 'לי', 'לך', 'לו', 'לה', 'לנו', 'להם',
  'עצמי', 'עצמך', 'עצמו', 'עצמה',
  // demonstratives and determiners
  'זה', 'זאת', 'זו', 'אלה', 'אלו', 'הזה', 'הזאת', 'הזו', 'האלה', 'האלו', 'כל', 'כמה', 'איזה', 'איזו', 'אילו',
  'שום', 'אחד', 'אחת', 'אחר', 'אחרת', 'אחרים', 'אחרות', 'עצמם',
  // prepositions and conjunctions
  'של', 'את', 'על', 'עם', 'אל', 'אצל', 'בין', 'לפני', 'אחרי', 'מאחורי', 'תחת', 'מתחת', 'מעל', 'בתוך', 'לתוך',
  'מתוך', 'ליד', 'בלי', 'כמו', 'כדי', 'לגבי', 'בגלל', 'למרות', 'אבל', 'אולם', 'אלא', 'או', 'אם', 'כי', 'כאשר',
  'כש', 'לכן', 'ולכן', 'גם', 'וגם', 'רק', 'עוד', 'כבר', 'אז', 'ואז', 'עד', 'מאז', 'לפי', 'דרך', 'בשביל', 'עבור',
  'כלומר', 'שוב', 'יותר', 'פחות', 'מאוד', 'ממש', 'פשוט', 'בערך', 'כמעט', 'לגמרי',
  // adverbs of place/time, question words
  'פה', 'שם', 'כאן', 'עכשיו', 'היום', 'אחר', 'תמיד', 'אף', 'פעם', 'מה', 'מי', 'איך', 'למה', 'מדוע', 'איפה',
  'מתי', 'כך', 'ככה', 'כזה', 'כזאת',
  // copulas, modals and fillers
  'יש', 'אין', 'היה', 'היתה', 'הייתה', 'היו', 'יהיה', 'תהיה', 'יהיו', 'להיות', 'הנה', 'צריך', 'צריכה', 'צריכים',
  'אפשר', 'אי', 'כן', 'לא', 'בבקשה', 'תודה', 'רגע', 'בסדר', 'אוקיי', 'שזה', 'שהוא', 'שהיא', 'שיש', 'שאין',
  'שכל', 'וזה', 'וגם', 'ועוד', 'כלל',
];

/**
 * Words of the default correction and additive cues (ledger.correctionCues / additiveCues). DESIGN §6.1
 * removes cue words from content words, so "actually use X" and "use X" compare on X alone.
 */
export const CUE_WORDS: readonly string[] = [
  'actually', 'instead', 'correction', 'scratch', 'ignore', 'previous', 'earlier', 'disregard', 'longer',
  'change', 'plan', 'rather', 'anymore', 'additionally', 'addition',
  'בעצם', 'במקום', 'תתעלם', 'משנה', 'תיקון',
];
