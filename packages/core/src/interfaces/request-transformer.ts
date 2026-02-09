/**
 * Request Transformer Interface
 * Decouples request transformation logic from transformers
 */

export interface RequestTransformer {
  /** Transformer name */
  name: string;
  
  /**
   * Transform outgoing request (client -> provider)
   * @param request - The request to transform
   * @returns Transformed request
   */
  transformOut(request: any): Promise<any>;
  
  /**
   * Transform incoming request (provider -> client)
   * @param request - The request to transform
   * @returns Transformed request
   */
  transformIn(request: any): Promise<any>;
}
