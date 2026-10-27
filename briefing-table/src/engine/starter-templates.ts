/* STARTER ROOM TEMPLATES: data, keyed by template. The app sends only {template, version}; the manifest lives here. Authoritative copy is
 * manifest B14 v3 (the design system, branch design/starter-rooms-ticket); where this differs, B14 wins. All seats are Claude and startable
 * (nothing is started by the seed). Seat order matters: the FIRST persistent seat added to a room becomes its lead, so each room lists its
 * lead first. Pure data, no imports, so a test can read it without an engine. */

export type StarterRecipeKey = 'starter-lead' | 'starter-builder';

export interface StarterSeat {
  handle: string;
  recipe: StarterRecipeKey;
}
export interface StarterGroup {
  /** the @alias of the workgroup, and the key in the answer */
  alias: string;
  name: string;
  seats: StarterSeat[]; // first = the group's lead
}
export interface StarterTemplate {
  key: string;
  /** the template data version (B14's). The version the app sends is recorded and otherwise ignored: a bump never reseeds. */
  version: number;
  roomName: string;
  brief: string;
  seats: StarterSeat[]; // first = the room lead
  groups: StarterGroup[];
}

/** The two recipes every template shares. `role` names the folder under the person's agents folder. */
export const STARTER_RECIPES: Record<StarterRecipeKey, { name: string; role: string }> = {
  'starter-lead': { name: 'Starter lead', role: 'lead' },
  'starter-builder': { name: 'Starter builder', role: 'builder' },
};

const L = (handle: string): StarterSeat => ({ handle, recipe: 'starter-lead' });
const B = (handle: string): StarterSeat => ({ handle, recipe: 'starter-builder' });

export const STARTER_TEMPLATES: Record<string, StarterTemplate> = {
  'my-project': {
    key: 'my-project',
    version: 3,
    roomName: 'My project',
    brief: 'A project room with four teams: @plan, @design, @build and @test. Ask project-lead for anything; it starts and directs the team leads, and they start their own teams.',
    seats: [L('project-lead')],
    groups: [
      { alias: 'plan', name: 'Plan', seats: [L('planner'), B('architect')] },
      { alias: 'design', name: 'Design', seats: [L('brand'), B('artist')] },
      { alias: 'build', name: 'Build', seats: [L('pm'), B('builder-1'), B('builder-2')] },
      { alias: 'test', name: 'Test', seats: [L('test-plans'), B('tester-1'), B('tester-2')] },
    ],
  },
  'my-first-room': {
    key: 'my-first-room',
    version: 1,
    roomName: 'My first room',
    brief: 'One room, two agents: planner and builder. Say what you want to planner; it can ask builder to do the work.',
    // NOT `lead`: the engine reserves it (@lead = the head room\'s lead). `coordination` also exists in My project; handles are unique per family and these are two families.
    seats: [L('planner'), B('builder')],
    groups: [],
  },
};
