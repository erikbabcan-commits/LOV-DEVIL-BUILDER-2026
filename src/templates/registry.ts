import saas from './blueprints/saas-landing';
import kanban from './blueprints/kanban';
import settings from './blueprints/settings';
import analytics from './blueprints/analytics-dashboard';
import blog from './blueprints/blog';
import todo from './blueprints/todo';
import chat from './blueprints/chat';
import ecommerce from './blueprints/ecommerce-catalog';
import portfolio from './blueprints/portfolio';
import admin from './blueprints/admin-crud';
import calendar from './blueprints/calendar';
import login from './blueprints/login-flow';
import booking from './blueprints/booking';
import invoice from './blueprints/invoice';
import eventRegistration from './blueprints/event-registration';
import jobBoard from './blueprints/job-board';
import recipes from './blueprints/recipes';
import membersArea from './blueprints/members-area';
import blogCms from './blueprints/blog-cms';

export const BLUEPRINT_REGISTRY = [
  saas, kanban, settings, analytics, blog, todo, chat, ecommerce, portfolio, admin, calendar, login,
  booking, invoice, eventRegistration, jobBoard, recipes, membersArea, blogCms,
];
const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('sk');
export function searchBlueprints(query: string, category = 'Všetky') {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  return BLUEPRINT_REGISTRY.filter(template => (category === 'Všetky' || template.category === category) &&
    terms.every(term => normalize([template.title, template.description, ...template.tags, ...template.features].join(' ')).includes(term)));
}
export function getBlueprint(id: string) { return BLUEPRINT_REGISTRY.find(template => template.id === id); }
