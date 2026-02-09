/**
 * Auth Provider Interface
 * Decouples authentication logic from transformers
 */

export interface AuthResult {
  /** Headers to add to the request */
  headers?: Record<string, string>;
  /** Modified request body */
  body?: any;
  /** Additional context */
  context?: Record<string, any>;
}

export interface AuthProvider {
  /** Provider name */
  name: string;
  
  /**
   * Authenticate a request
   * @param request - The outgoing request
   * @param provider - Provider configuration
   * @returns Authentication result with headers/body modifications
   */
  authenticate(request: any, provider: any): Promise<AuthResult>;
}
