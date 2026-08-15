import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";

/**
 * Single-user stand-in for real authentication. Every request is scoped to
 * this user until a real auth system replaces it — callers should treat
 * this as "the current user" so that swapping in real session lookup later
 * only touches this function.
 */
export async function getCurrentUser() {
  return prisma.user.upsert({
    where: { email: env.DEV_USER_EMAIL },
    update: {},
    create: { email: env.DEV_USER_EMAIL, name: "Dev User" },
  });
}
