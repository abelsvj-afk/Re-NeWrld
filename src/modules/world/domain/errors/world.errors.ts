export class WorldError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
  }
}

export class WorldNotFoundError extends WorldError {
  constructor(message: string = 'World not found') {
    super(message, 404);
  }
}

export class WorldValidationError extends WorldError {
  constructor(message: string) {
    super(message, 400);
  }
}
