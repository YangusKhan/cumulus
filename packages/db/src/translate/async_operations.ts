import { toSnake } from 'snake-camel';
import { ApiAsyncOperation } from '@cumulus/types/api/async_operations';
import { PostgresAsyncOperation } from '../types/async_operation';

export const translateApiAsyncOperationToPostgresAsyncOperation = (
  record: ApiAsyncOperation
): PostgresAsyncOperation => {
  // fix for old implementation of async-operation output assignment
  const translatedRecord = <PostgresAsyncOperation>toSnake(record);
  if (record.output === 'none') {
    delete translatedRecord.output;
  } else if (record.output !== undefined) {
    translatedRecord.output = JSON.parse(JSON.stringify(record.output));
  }
  if (record.createdAt !== undefined) {
    translatedRecord.created_at = new Date(record.createdAt);
  }
  if (record.updatedAt !== undefined) {
    translatedRecord.updated_at = new Date(record.updatedAt);
  }
  return translatedRecord;
};

export const translatePostgresAsyncOperationToApiAsyncOperation = (
  pgAsyncOperation: PostgresAsyncOperation
): ApiAsyncOperation => {
  const apiAsyncOperation = {
    id: pgAsyncOperation.id,
    description: pgAsyncOperation.description,
    operationType: pgAsyncOperation.operation_type,
    status: pgAsyncOperation.status,
    output: pgAsyncOperation.output ? JSON.stringify(pgAsyncOperation.output) : undefined,
    taskArn: pgAsyncOperation.task_arn ? pgAsyncOperation.task_arn : undefined,
    createdAt: pgAsyncOperation.created_at ? pgAsyncOperation.created_at.getTime() : undefined,
    updatedAt: pgAsyncOperation.updated_at ? pgAsyncOperation.updated_at.getTime() : undefined,
  };
  return apiAsyncOperation;
};
