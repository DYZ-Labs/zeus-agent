import { beforeEach, describe, expect, it } from "vitest";

import type { Db } from "./db";
import { openTestDb } from "./db";
import {
  addAlias,
  aliasesOf,
  foldAlias,
  getEntity,
  listEntities,
  mergeEntities,
  resolveEntity,
  selfEntity,
  slugify,
  upsertEntity,
} from "./entities";
import { factsForEntity, recordFact } from "./facts";

let db: Db;

beforeEach(() => {
  db = openTestDb();
});

describe("normalization", () => {
  it("folds aliases to a comparable form", () => {
    expect(foldAlias("  Sarah   Chen ")).toBe("sarah chen");
    expect(foldAlias("SARAH")).toBe("sarah");
  });

  it("slugifies names, including accented ones", () => {
    expect(slugify("Sarah Chen")).toBe("sarah-chen");
    expect(slugify("Café Zürich")).toBe("cafe-zurich");
    expect(slugify("!!!")).toBe("entity");
  });
});

describe("resolution", () => {
  it("treats Sarah, Sarah Chen, and sarah as one person", () => {
    const created = upsertEntity(db, {
      name: "Sarah Chen",
      kind: "person",
      aliases: ["Sarah"],
    });

    expect(resolveEntity(db, "Sarah")?.id).toBe(created.id);
    expect(resolveEntity(db, "sarah chen")?.id).toBe(created.id);
    expect(resolveEntity(db, "  SARAH  ")?.id).toBe(created.id);

    // One entity, not three. (`self` is also a person, so exclude it.)
    const people = listEntities(db, { kind: "person" }).filter((e) => e.slug !== "self");
    expect(people).toHaveLength(1);
  });

  it("returns null for someone it has never heard of", () => {
    expect(resolveEntity(db, "Nobody At All")).toBeNull();
  });

  it("upserting an existing entity adds aliases rather than duplicating", () => {
    const first = upsertEntity(db, { name: "Acme", kind: "org" });
    const second = upsertEntity(db, { name: "Acme", kind: "org", aliases: ["Acme Corp"] });

    expect(second.id).toBe(first.id);
    expect(aliasesOf(db, first.id)).toContain("acme corp");
  });

  it("keeps an alias bound to its first owner rather than crashing on collision", () => {
    const chen = upsertEntity(db, { name: "Sarah Chen", kind: "person", aliases: ["Sarah"] });
    const jones = upsertEntity(db, { name: "Sarah Jones", kind: "person" });

    // "Sarah" is already taken; binding it again must not throw or steal it.
    expect(addAlias(db, jones.id, "Sarah")).toBe(false);
    expect(resolveEntity(db, "Sarah")?.id).toBe(chen.id);
    expect(resolveEntity(db, "Sarah Jones")?.id).toBe(jones.id);
  });

  it("disambiguates colliding slugs", () => {
    const a = upsertEntity(db, { name: "Apollo", kind: "project" });
    // Same display name, different entity forced through by a distinct alias set.
    db.prepare(
      "INSERT INTO entity (kind, name, slug, created_at, updated_at) VALUES ('org','Apollo','apollo-2','x','x')",
    ).run();

    expect(a.slug).toBe("apollo");
    expect(upsertEntity(db, { name: "Apollo", kind: "project" }).id).toBe(a.id);
  });
});

describe("the self entity", () => {
  it("exists on a fresh database and answers to first-person aliases", () => {
    const me = selfEntity(db);
    expect(me.slug).toBe("self");
    expect(resolveEntity(db, "me")?.id).toBe(me.id);
    expect(resolveEntity(db, "I")?.id).toBe(me.id);
  });
});

describe("merging", () => {
  it("folds a duplicate entity into the canonical one without losing facts", () => {
    const short = upsertEntity(db, { name: "Sarah", kind: "person" });
    const full = upsertEntity(db, { name: "Sarah Chen", kind: "person" });

    recordFact(db, { subjectId: short.id, predicate: "likes", object: "hiking" });
    recordFact(db, { subjectId: full.id, predicate: "works_at", object: "Acme" });

    mergeEntities(db, short.id, full.id);

    expect(getEntity(db, short.id)).toBeNull();
    const facts = factsForEntity(db, full.id);
    expect(facts.map((fact) => fact.object).sort()).toEqual(["Acme", "hiking"]);
    expect(resolveEntity(db, "Sarah")?.id).toBe(full.id);
  });

  it("re-points incoming graph edges when merging", () => {
    const me = selfEntity(db).id;
    const short = upsertEntity(db, { name: "Acme", kind: "org" });
    const full = upsertEntity(db, { name: "Acme Corporation", kind: "org" });

    recordFact(db, {
      subjectId: me,
      predicate: "works_at",
      object: "Acme",
      objectEntityId: short.id,
    });

    mergeEntities(db, short.id, full.id);

    const facts = factsForEntity(db, full.id, { includeIncoming: true });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.object_entity_id).toBe(full.id);
  });

  it("refuses to merge away the self entity", () => {
    const me = selfEntity(db);
    const other = upsertEntity(db, { name: "Someone", kind: "person" });
    expect(() => mergeEntities(db, me.id, other.id)).toThrow(/self/u);
  });
});
