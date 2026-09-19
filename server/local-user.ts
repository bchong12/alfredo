/**
 * The user every local workspace belongs to. There is no sign-in for a folder
 * on your own disk, and every ownership check in the routes compares against
 * this id, so it has to be stable. Kept in a file with no imports so the edge
 * bundle can name it without pulling in the embedded database.
 */
export const LOCAL_USER = { id: '00000000-0000-4000-8000-000000000001', email: '', name: 'You' }
