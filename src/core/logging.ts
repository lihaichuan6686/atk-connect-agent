export function diagnostic(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function diagnosticError(message: string): void {
  process.stderr.write(`${message}\n`);
}
