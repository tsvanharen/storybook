import path from 'path';
import fse from 'fs-extra';
import { DefinePlugin, HotModuleReplacementPlugin, ProgressPlugin } from 'webpack';
import Dotenv from 'dotenv-webpack';
// @ts-ignore
import { Configuration, RuleSetRule } from '@types/webpack';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import CaseSensitivePathsPlugin from 'case-sensitive-paths-webpack-plugin';
import WatchMissingNodeModulesPlugin from 'react-dev-utils/WatchMissingNodeModulesPlugin';
import TerserWebpackPlugin from 'terser-webpack-plugin';
import VirtualModulePlugin from 'webpack-virtual-modules';
import PnpWebpackPlugin from 'pnp-webpack-plugin';
import ForkTsCheckerWebpackPlugin from 'fork-ts-checker-webpack-plugin';
// @ts-ignore
import FilterWarningsPlugin from 'webpack-filter-warnings-plugin';
import dedent from 'ts-dedent';

import themingPaths from '@storybook/theming/paths';

import {
  toRequireContextString,
  stringifyEnvs,
  es6Transpiler,
  handlebars,
  interpolate,
  nodeModulesPaths,
  Options,
  NormalizedStoriesEntry,
  toImportFn,
} from '@storybook/core-common';
import { createBabelLoader } from './babel-loader-preview';

import { useBaseTsSupport } from './useBaseTsSupport';

const storybookPaths: Record<string, string> = [
  'addons',
  'api',
  'channels',
  'channel-postmessage',
  'components',
  'core-events',
  'router',
  'theming',
  'semver',
  'client-api',
  'client-logger',
  'web-preview',
  'store',
].reduce(
  (acc, sbPackage) => ({
    ...acc,
    [`@storybook/${sbPackage}`]: path.dirname(
      require.resolve(`@storybook/${sbPackage}/package.json`)
    ),
  }),
  {}
);

async function readTemplate(filename: string) {
  return fse.readFile(path.join(__dirname, filename), {
    encoding: 'utf8',
  });
}

export default async ({
  configDir,
  babelOptions,
  entries,
  configs,
  stories,
  outputDir = path.join('.', 'public'),
  quiet,
  packageJson,
  configType,
  framework,
  frameworkPath,
  presets,
  typescriptOptions,
  modern,
  features,
}: Options & Record<string, any>): Promise<Configuration> => {
  const logLevel = await presets.apply('logLevel', undefined);
  const frameworkOptions = await presets.apply(`${framework}Options`, {});

  const headHtmlSnippet = await presets.apply('previewHead');
  const bodyHtmlSnippet = await presets.apply('previewBody');
  const template = await presets.apply<string>('previewMainTemplate');
  const envs = await presets.apply<Record<string, string>>('env');

  const babelLoader = createBabelLoader(babelOptions, framework);
  const isProd = configType === 'PRODUCTION';
  const configEntryPath = path.resolve(path.join(configDir, 'storybook-config-entry.js'));

  const virtualModuleMapping: Record<string, string> = {};
  // TODO -- this is likely a separate feature onDemandStore?
  if (features.buildStoriesJson) {
    const storiesFilename = 'storybook-stories.js';
    const storiesPath = path.resolve(path.join(configDir, storiesFilename));

    virtualModuleMapping[storiesPath] = toImportFn(stories);
    virtualModuleMapping[configEntryPath] = handlebars(
      await readTemplate('virtualModuleModernEntry.js.handlebars'),
      {
        storiesFilename,
        configs,
      }
    );
    entries.push(configEntryPath);
  } else {
    const frameworkInitEntry = path.resolve(
      path.join(configDir, 'storybook-init-framework-entry.js')
    );
    const frameworkImportPath = frameworkPath || `@storybook/${framework}`;
    virtualModuleMapping[frameworkInitEntry] = `import '${frameworkImportPath}';`;
    entries.push(frameworkInitEntry);

    const entryTemplate = await readTemplate('virtualModuleEntry.template.js');

    configs.forEach((configFilename: any) => {
      const clientApi = storybookPaths['@storybook/client-api'];
      const clientLogger = storybookPaths['@storybook/client-logger'];

      virtualModuleMapping[`${configFilename}-generated-config-entry.js`] = interpolate(
        entryTemplate,
        {
          configFilename,
          clientApi,
          clientLogger,
        }
      );
      entries.push(`${configFilename}-generated-config-entry.js`);
    });
    if (stories) {
      const storyTemplate = await readTemplate('virtualModuleStory.template.js');
      const storiesFilename = path.resolve(path.join(configDir, `generated-stories-entry.js`));
      virtualModuleMapping[storiesFilename] = interpolate(storyTemplate, { frameworkImportPath })
        // Make sure we also replace quotes for this one
        .replace(
          "'{{stories}}'",
          stories
            .map((s: NormalizedStoriesEntry) => s.glob)
            .map(toRequireContextString)
            .join(',')
        );
      entries.push(storiesFilename);
    }
  }

  Object.entries(virtualModuleMapping).forEach(([filePath, file]) => {
    console.log(filePath);
    console.log();
    console.log(file);
  });

  const shouldCheckTs = useBaseTsSupport(framework) && typescriptOptions.check;
  const tsCheckOptions = typescriptOptions.checkOptions || {};

  return {
    name: 'preview',
    mode: isProd ? 'production' : 'development',
    bail: isProd,
    devtool: 'cheap-module-source-map',
    entry: entries,
    // stats: 'errors-only',
    output: {
      path: path.resolve(process.cwd(), outputDir),
      filename: isProd ? '[name].[contenthash:8].iframe.bundle.js' : '[name].iframe.bundle.js',
      publicPath: '',
    },
    watchOptions: {
      ignored: /node_modules/,
    },
    plugins: [
      new FilterWarningsPlugin({
        exclude: /export '\S+' was not found in 'global'/,
      }),
      Object.keys(virtualModuleMapping).length > 0
        ? new VirtualModulePlugin(virtualModuleMapping)
        : null,
      new HtmlWebpackPlugin({
        filename: `iframe.html`,
        // FIXME: `none` isn't a known option
        chunksSortMode: 'none' as any,
        alwaysWriteToDisk: true,
        inject: false,
        templateParameters: (compilation, files, options) => ({
          compilation,
          files,
          options,
          version: packageJson.version,
          globals: {
            LOGLEVEL: logLevel,
            FRAMEWORK_OPTIONS: frameworkOptions,
            FEATURES: features,
            STORIES: stories,
          },
          headHtmlSnippet,
          bodyHtmlSnippet,
        }),
        minify: {
          collapseWhitespace: true,
          removeComments: true,
          removeRedundantAttributes: true,
          removeScriptTypeAttributes: false,
          removeStyleLinkTypeAttributes: true,
          useShortDoctype: true,
        },
        template,
      }),
      new DefinePlugin({
        'process.env': stringifyEnvs(envs),
        NODE_ENV: JSON.stringify(envs.NODE_ENV),
      }),
      isProd ? null : new WatchMissingNodeModulesPlugin(nodeModulesPaths),
      isProd ? null : new HotModuleReplacementPlugin(),
      new CaseSensitivePathsPlugin(),
      quiet ? null : new ProgressPlugin({}),
      new Dotenv({ silent: true }),
      shouldCheckTs ? new ForkTsCheckerWebpackPlugin(tsCheckOptions) : null,
    ].filter(Boolean),
    module: {
      rules: [
        babelLoader,
        es6Transpiler() as RuleSetRule,
        {
          test: /\.md$/,
          use: [
            {
              loader: require.resolve('raw-loader'),
            },
          ],
        },
      ],
    },
    resolve: {
      extensions: ['.mjs', '.js', '.jsx', '.ts', '.tsx', '.json', '.cjs'],
      modules: ['node_modules'].concat(envs.NODE_PATH || []),
      mainFields: [modern ? 'sbmodern' : null, 'browser', 'module', 'main'].filter(Boolean),
      alias: {
        ...themingPaths,
        ...storybookPaths,
        react: path.dirname(require.resolve('react/package.json')),
        'react-dom': path.dirname(require.resolve('react-dom/package.json')),
      },

      plugins: [
        // Transparently resolve packages via PnP when needed; noop otherwise
        PnpWebpackPlugin,
      ],
    },
    resolveLoader: {
      plugins: [PnpWebpackPlugin.moduleLoader(module)],
    },
    optimization: {
      splitChunks: {
        chunks: 'all',
      },
      runtimeChunk: true,
      sideEffects: true,
      usedExports: true,
      moduleIds: 'named',
      minimizer: isProd
        ? [
            new TerserWebpackPlugin({
              parallel: true,
              terserOptions: {
                sourceMap: true,
                mangle: false,
                keep_fnames: true,
              },
            }),
          ]
        : [],
    },
    performance: {
      hints: isProd ? 'warning' : false,
    },
  };
};
