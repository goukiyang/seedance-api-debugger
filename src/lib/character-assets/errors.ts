/** Browser-safe error used by shared input parsing and directory services. */
export class CharacterAssetError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message);
    this.name = 'CharacterAssetError';
  }
}
