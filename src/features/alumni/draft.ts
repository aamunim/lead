// 📣 The alumni marked on the list, for a new campaign (too many for a link)
let ids: string[] = [];

export const campaignDraft = {
  set(v: string[]) {
    ids = [...v];
  },
  /** the marked ones (kept until a campaign is made) */
  get(): string[] {
    return ids;
  },
  clear() {
    ids = [];
  },
};
