import path from 'node:path';
import { app } from '@platform';
import { AgentSessionIndex } from '../services/agentSessionIndex';
import { readSettings } from './settings';

export const agentSessionIndex = new AgentSessionIndex({
  readSettings,
  sessionDir: () => path.join(app.getPath('userData'), 'agent', 'sessions'),
});
