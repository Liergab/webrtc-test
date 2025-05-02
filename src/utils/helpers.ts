// Generate a random room ID (8 characters)
export const generateRandomId = (): string => {
  return Math.random().toString(36).substring(2, 10);
};