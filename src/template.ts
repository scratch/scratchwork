import { getRepoRoot } from './util';
import path from 'path';

export default {
  markdownComponentsTemplateDir: path.resolve(
    getRepoRoot(),
    'template/default/components/markdown'
  ),
  defaultTemplateDir: path.resolve(getRepoRoot(), 'template/default'),
  examplesTemplateDir: path.resolve(getRepoRoot(), 'template/examples'),
  internalTemplateDir: path.resolve(getRepoRoot(), 'template/internal'),
};
