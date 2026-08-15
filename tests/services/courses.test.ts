import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import {
  createCourse,
  deleteCourse,
  getCourseWithDocuments,
  listCourses,
} from "@/lib/services/courses";

describe("courses service", () => {
  let userA: { id: string };
  let userB: { id: string };

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userA = await prisma.user.create({ data: { email: `test-course-a-${suffix}@example.com` } });
    userB = await prisma.user.create({ data: { email: `test-course-b-${suffix}@example.com` } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
  });

  it("creates and retrieves a course", async () => {
    const course = await createCourse(userA.id, {
      title: "Cybersecurity",
      description: "Intro course",
    });
    expect(course.title).toBe("Cybersecurity");
    expect(course.status).toBe("active");

    const fetched = await getCourseWithDocuments(userA.id, course.id);
    expect(fetched?.id).toBe(course.id);
    expect(fetched?.documents).toEqual([]);
  });

  it("lists only the owner's courses", async () => {
    const course = await createCourse(userA.id, { title: "Networking" });

    const listA = await listCourses(userA.id);
    const listB = await listCourses(userB.id);

    expect(listA.some((c) => c.id === course.id)).toBe(true);
    expect(listB.some((c) => c.id === course.id)).toBe(false);
  });

  it("does not let a different user read or delete someone else's course", async () => {
    const course = await createCourse(userA.id, { title: "Private course" });

    expect(await getCourseWithDocuments(userB.id, course.id)).toBeNull();
    expect(await deleteCourse(userB.id, course.id)).toBe(false);
    expect(await getCourseWithDocuments(userA.id, course.id)).not.toBeNull();
  });

  it("deletes a course owned by the user", async () => {
    const course = await createCourse(userA.id, { title: "To delete" });

    expect(await deleteCourse(userA.id, course.id)).toBe(true);
    expect(await getCourseWithDocuments(userA.id, course.id)).toBeNull();
  });
});
