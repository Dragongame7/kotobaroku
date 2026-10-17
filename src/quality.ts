export function normalizedCharacters(text: string) {
  return Array.from(text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\p{P}\p{Z}\s]/gu, ''));
}
export function characterErrorRate(reference: string, hypothesis: string) {
  const a = normalizedCharacters(reference), b = normalizedCharacters(hypothesis);
  if (!a.length) return null;
  let previous = new Uint32Array(b.length + 1); for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const row = new Uint32Array(b.length + 1); row[0] = i;
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
    previous = row;
  }
  return { errors: previous[b.length], length: a.length, percent: previous[b.length] / a.length * 100 };
}
