export class ApiError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
  }

  static notFound(message = "Resource not found") {
    return new ApiError(404, "not_found", message);
  }

  static badRequest(message = "Invalid request") {
    return new ApiError(400, "bad_request", message);
  }

  static unauthorized(message = "Missing or invalid API key") {
    return new ApiError(401, "unauthorized", message);
  }

  static rateLimited(message = "Rate limit exceeded") {
    return new ApiError(429, "rate_limited", message);
  }

  static forbidden(message = "Not permitted") {
    return new ApiError(403, "forbidden", message);
  }
}
