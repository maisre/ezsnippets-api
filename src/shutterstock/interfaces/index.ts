export interface ShutterstockImage {
  /**
   * Shutterstock asset id. Persisted alongside the chosen preview URL on the
   * page so a licensing hand-off can be assembled later — see
   * imageReplacementOverride in pages/interfaces/snippet-abstract.interface.ts.
   */
  id: string;
  description: string;
  /** Watermarked 450px preview comp. Intentional: pages are mockups. */
  previewUrl: string;
  width: number;
  height: number;
  /** width / height, as reported by Shutterstock. */
  aspect: number;
}

export interface ImageSearchResult {
  success: boolean;
  query: string;
  totalCount: number;
  images: ShutterstockImage[];
}
