export const PAGE_SIZE = 25;
export function pageOf(records, requestedPage = 0) {
  const pages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const page = Math.min(pages - 1, Math.max(0, requestedPage));
  const start = page * PAGE_SIZE;
  return {page,pages,start,end:Math.min(records.length,start+PAGE_SIZE),rows:records.slice(start,start+PAGE_SIZE)};
}
