// A list of numbers as Postgres writes a vector: "[0.1,0.2,…]". On its own
// because everything else about embeddings needs a model on this machine, and
// this one line is needed wherever a database is written to.
export const toVector = (v: number[]) => `[${v.map((x) => x.toFixed(6)).join(',')}]`
