'use strict';
// The pilot's seat rule as a web-only facade (wb.web.seat): Claude Code and Codex can join a room; the seat lists, their words and the refusal.
// The rooms page reads it at call time, so the desktop build and the page's extracted-source tests never see it.
const rule=require('../../src/renderer/rooms/seat-recipes.js');
function register(api){api.expose('seat',Object.freeze({seatRecipes:rule.seatRecipes,refusal:rule.refusal,applies:rule.applies,programName:rule.programName,WORDS:rule.WORDS,SEAT_VENDORS:rule.SEAT_VENDORS}));}
module.exports={register};
