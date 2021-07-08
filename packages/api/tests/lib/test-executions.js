const test = require('ava');
const cryptoRandomString = require('crypto-random-string');

const { chooseTargetExecution } = require('../../lib/executions');

const randomArn = () => `arn_${cryptoRandomString({ length: 10 })}`;
const randomGranuleId = () => `granuleId_${cryptoRandomString({ length: 10 })}`;
const randomWorkflow = () => `workflow_${cryptoRandomString({ length: 10 })}`;

process.env.PG_HOST = `hostname_${cryptoRandomString({ length: 10 })}`;
process.env.PG_USER = `user_${cryptoRandomString({ length: 10 })}`;
process.env.PG_PASSWORD = `password_${cryptoRandomString({ length: 10 })}`;
process.env.PG_DATABASE = `password_${cryptoRandomString({ length: 10 })}`;

test('chooseTargetExecution() returns executionArn if provided.', async (t) => {
  const executionArn = randomArn();
  const granuleId = randomGranuleId();
  const expected = executionArn;

  const actual = await chooseTargetExecution({ granuleId, executionArn });

  t.is(expected, actual);
});

test('chooseTargetExecution() returns undefined if no executionarn nor workflowName are provided.', async (t) => {
  const granuleId = randomGranuleId();
  const expected = undefined;

  const actual = await chooseTargetExecution({ granuleId });

  t.is(expected, actual);
});

test('chooseTargetExecution() returns the first arn found in the database if a workflowName is provided.', async (t) => {
  const workflowName = randomWorkflow();
  const granuleId = randomGranuleId();
  const arn = randomArn();
  const testDbFunction = () =>
    Promise.resolve([{ arn }, { arn: randomArn() }, { arn: randomArn() }]);

  const actual = await chooseTargetExecution({
    granuleId,
    workflowName,
    dbFunction: testDbFunction,
  });

  t.is(actual[0].arn, t.context.arn);
});
