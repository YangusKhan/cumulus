const {
  getKnexClient,
  executionArnsFromGranuleIdsAndWorkflowNames,
} = require('@cumulus/db');

/**
 *  Finds and returns alternative executionArn related to the input granuleId.
 *  Used to override the default (latest) executionArn when reingesting granules.
 *  The decision tree is simple.
 *  1. If a user inputs an executionArn we return it.
 *  2. If not and no workflowName is specified, we return undefined so that the
 *  granule's original execution is retained during reingest.
 *  3. if not and a workflowName is input, we search the database for all
 *  executions that match the granuleId and workflowName and return the most
 *  recent.
 *
 * @param {string} granuleId - granuleId
 * @param {string|undefined} [executionArn] - exection arn to use for reingest
 * @param {string|undefined} [workflowName] - workflow name to use for reingest
 * @returns {Promise<string>|Promise<undefined>} - executionArn used in a
 *             granule reingest call to determine correct workflow to run or
 *             undefined.
 */
const chooseTargetExecution = async (
  granuleId,
  executionArn = undefined,
  workflowName = undefined
) => {
  // if a user specified an executionArn, use that always
  if (executionArn !== undefined) return executionArn;
  // if a user didn't specify a workflow, return undefined explicitly
  if (workflowName === undefined) return undefined;

  const knex = await getKnexClient({ env: process.env });
  const executions = await executionArnsFromGranuleIdsAndWorkflowNames(
    knex,
    [granuleId],
    [workflowName]
  );
  return executions[0].arn;
};

module.exports = { chooseTargetExecution };
