# Genealogy

A family graph over the people the platform already knows about, plus the
living relatives families record themselves.

Not in the specification documents. This is a later product direction, so the
reasoning below is the only place its constraints are written down.

## The shape

- **`family_people`** — a node. Either it points at a memorial's subject
  (`deceased_person_id`) or it carries its own name. Never both; a check
  constraint enforces it.
- **`family_links`** — parent and partner edges only. Siblings are derived.
- **`family_match_suggestions`** — two nodes that might be the same person.

## Five things that are load-bearing

**A node with a memorial holds no name of its own.** Names live on the
memorial, so a correction propagates and a name the family marked unsearchable
stays that way instead of resurfacing in a tree.

**Siblings are derived, never stored.** A stored sibling edge can contradict
the parent edges around it. A tree that contradicts itself makes every other
edge in it suspect.

**An edge is a claim until both sides accept.** Only confirmed edges are
traversed, so proposing a link is not a way to read into a family that has not
agreed to know you. Whoever speaks for a node is *derived* from the memorial's
membership — see `steward.ts` — so transferring a memorial transfers the right
to answer for that relative. A stored steward column would go stale in exactly
the contested case where it matters.

**The older node is asked first.** This is the security property in
`matching.ts`, not an ordering detail. Without it, creating nodes for guessed
names and watching which produce a suggestion is an enumeration oracle over
private memorials. A fresh node is always the newer side, and the newer side is
told nothing — not even that a suggestion exists — until the older side
accepts.

**Traversal asks about every node separately.** Being reachable through the
graph is never itself a reason to be told who somebody is. An edge two families
agreed on does not extend to a third family standing behind one of them.

## What a reader is not told

A node they may not see comes back as `{ visible: false, ref }` — no id, no
name, no dates, no slug. It cannot be used as a handle to probe with.

Dropping it entirely would be worse: the tree would lie about its own shape,
and the gap would read as the family's own records being incomplete rather than
as someone else's privacy.

## Deliberately optional

`parent_nature` (birth, adoptive, step, foster) defaults to `unspecified` and
stays that way unless a family says otherwise. The matching engine never reads
it. A tree that requires the field forces every adoptive family to declare
itself, and turns the system into something that can tell a person they were
adopted before their family chose to.

## Known residual disclosure

The older side of a suggestion learns that *somebody* recorded a person
matching their relative. Not who, not from where. That is the irreducible cost
of the feature existing at all, and it is the only disclosure in the design that
is not consented to on both sides beforehand.

## Not done yet

- **Merging matched nodes.** Both sides accepting sets the suggestion to
  `matched`; nothing yet absorbs one node into the other. The merge has to move
  edges, refuse to create a cycle, and keep `merged_into_person_id` for
  traceability. Until it lands, a confirmed match is a recorded agreement and
  nothing more.
- **Nothing is visible.** There is no UI for any of this, as there is no UI for
  memorials either.
- **`findMatches` compares every pair.** Fine for now, quadratic later. It needs
  blocking on a normalized name before the graph is large.
