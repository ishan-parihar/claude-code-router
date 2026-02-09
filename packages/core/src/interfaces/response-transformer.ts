/**
 * Response Transformer Interface
 * Decouples response transformation logic from transformers
 */

export interface ResponseTransformer {
  /** Transformer name */
  name: string;
  
  /**
   * Transform response (provider -> client)
   * @param response - The response to transform
   * @returns Transformed response
   */
  transform(response: Response): Promise<Response>;
}
