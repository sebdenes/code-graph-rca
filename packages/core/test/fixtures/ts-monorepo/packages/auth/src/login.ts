import { AuthError } from "@fixture/shared";
import { getEnv } from "@fixture/config";
import { hashPassword } from "./hash";
import { Session } from "./session";

const KNOWN: Record<string, string> = {
  alice: hashPassword("correct-horse"),
};

export async function login(user: string, pass: string): Promise<Session> {
  const timeout = getEnv("AUTH_TIMEOUT_MS");

  const attempt = new Promise<Session>((resolve, reject) => {
    const expected = KNOWN[user];
    if (expected && expected === hashPassword(pass)) {
      const s = new Session(user);
      s.touch();
      resolve(s);
    } else {
      reject(new AuthError("invalid credentials"));
    }
  });

  const timer = new Promise<Session>((_, reject) => {
    setTimeout(() => reject(new AuthError("login timeout")), timeout as unknown as number);
  });

  return Promise.race([attempt, timer]);
}
