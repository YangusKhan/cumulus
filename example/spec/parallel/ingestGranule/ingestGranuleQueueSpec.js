'use strict';

const fs = require('fs-extra');
const path = require('path');
const pMap = require('p-map');
const pRetry = require('p-retry');
const { URL, resolve } = require('url');

const {
  Execution,
  Granule,
  Pdr,
  Provider,
} = require('@cumulus/api/models');
const GranuleFilesCache = require('@cumulus/api/lib/GranuleFilesCache');
const {
  parseS3Uri,
  s3GetObjectTagging,
  s3ObjectExists,
} = require('@cumulus/aws-client/S3');
const { s3 } = require('@cumulus/aws-client/services');
const { generateChecksumFromStream } = require('@cumulus/checksum');
const { constructCollectionId } = require('@cumulus/message/Collections');
const {
  addCollections,
  conceptExists,
  getOnlineResources,
  waitForCompletedExecution,
} = require('@cumulus/integration-tests');
const apiTestUtils = require('@cumulus/integration-tests/api/api');
const { deleteCollection } = require('@cumulus/api-client/collections');
const { deleteExecution } = require('@cumulus/api-client/executions');
const { getGranule, removePublishedGranule } = require('@cumulus/api-client/granules');
const {
  getDistributionFileUrl,
  getTEADistributionApiRedirect,
  getTEADistributionApiFileStream,
  getTEARequestHeaders,
} = require('@cumulus/integration-tests/api/distribution');
const { LambdaStep } = require('@cumulus/integration-tests/sfnStep');

const { buildAndStartWorkflow } = require('../../helpers/workflowUtils');
const {
  loadConfig,
  templateFile,
  uploadTestDataToBucket,
  deleteFolder,
  createTimestampedTestId,
  createTestDataPath,
  createTestSuffix,
} = require('../../helpers/testUtils');
const {
  setDistributionApiEnvVars,
  waitForModelStatus,
} = require('../../helpers/apiUtils');
const {
  addUniqueGranuleFilePathToGranuleFiles,
  addUrlPathToGranuleFiles,
  setupTestGranuleForIngest,
  loadFileWithUpdatedGranuleIdPathAndCollection,
} = require('../../helpers/granuleUtils');

const lambdaStep = new LambdaStep();
const workflowName = 'IngestGranuleQueue';

const granuleRegex = '^MOD09GQ\\.A[\\d]{7}\\.[\\w]{6}\\.006\\.[\\d]{13}$';

const s3data = [
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf.met',
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606.hdf',
  '@cumulus/test-data/granules/MOD09GQ.A2016358.h13v04.006.2016360104606_ndvi.jpg',
];

const SetupError = new Error('Test setup failed, aborting');

describe('The S3 Ingest Granules workflow', () => {
  const inputPayloadFilename = './spec/parallel/ingestGranule/IngestGranule.input.payload.json';
  const providersDir = './data/providers/s3/';
  const collectionsDir = './data/collections/s3_MOD09GQ_006_full_ingest';
  const collectionDupeHandling = 'error';

  let beforeAllError = false;
  let collection;
  let config;
  let executionModel;
  let expectedPayload;
  let expectedS3TagSet;
  let expectedSyncGranulePayload;
  let granuleModel;
  let inputPayload;
  let pdrFilename;
  let pdrModel;
  let postToCmrOutput;
  let provider;
  let providerModel;
  let publishGranuleExecutionArn;
  let testDataFolder;
  let workflowExecutionArn;

  beforeAll(async () => {
    try {
      config = await loadConfig();
      const testId = createTimestampedTestId(config.stackName, 'IngestGranuleQueue');
      const testSuffix = createTestSuffix(testId);
      testDataFolder = createTestDataPath(testId);

      collection = { name: `MOD09GQ${testSuffix}`, version: '006' };
      const newCollectionId = constructCollectionId(collection.name, collection.version);
      provider = { id: `s3_provider${testSuffix}` };

      process.env.GranulesTable = `${config.stackName}-GranulesTable`;
      granuleModel = new Granule();
      process.env.ExecutionsTable = `${config.stackName}-ExecutionsTable`;
      executionModel = new Execution();
      process.env.system_bucket = config.bucket;
      process.env.ProvidersTable = `${config.stackName}-ProvidersTable`;
      providerModel = new Provider();
      process.env.PdrsTable = `${config.stackName}-PdrsTable`;
      pdrModel = new Pdr();

      const providerJson = JSON.parse(fs.readFileSync(`${providersDir}/s3_provider.json`, 'utf8'));
      const providerData = {
        ...providerJson,
        id: provider.id,
        host: config.bucket,
      };

      // populate collections, providers and test data
      await Promise.all([
        uploadTestDataToBucket(config.bucket, s3data, testDataFolder),
        addCollections(config.stackName, config.bucket, collectionsDir, testSuffix, testId, collectionDupeHandling),
        apiTestUtils.addProviderApi({ prefix: config.stackName, provider: providerData }),
      ]);

      const inputPayloadJson = fs.readFileSync(inputPayloadFilename, 'utf8');
      // update test data filepaths
      inputPayload = await setupTestGranuleForIngest(config.bucket, inputPayloadJson, granuleRegex, testSuffix, testDataFolder);
      pdrFilename = inputPayload.pdr.name;
      const granuleId = inputPayload.granules[0].granuleId;
      expectedS3TagSet = [{ Key: 'granuleId', Value: granuleId }];
      await Promise.all(inputPayload.granules[0].files.map((fileToTag) =>
        s3().putObjectTagging({ Bucket: config.bucket, Key: `${fileToTag.path}/${fileToTag.name}`, Tagging: { TagSet: expectedS3TagSet } }).promise()));

      const collectionUrlString = '{cmrMetadata.Granule.Collection.ShortName}___{cmrMetadata.Granule.Collection.VersionId}/{substring(file.name, 0, 3)}/';

      const templatedSyncGranuleFilename = templateFile({
        inputTemplateFilename: './spec/parallel/ingestGranule/SyncGranule.output.payload.template.json',
        config: {
          granules: [
            {
              files: [
                {
                  bucket: config.buckets.internal.name,
                  filename: `s3://${config.buckets.internal.name}/file-staging/${config.stackName}/replace-me-collectionId/replace-me-granuleId.hdf`,
                  fileStagingDir: `file-staging/${config.stackName}/replace-me-collectionId`,
                },
                {
                  bucket: config.buckets.internal.name,
                  filename: `s3://${config.buckets.internal.name}/file-staging/${config.stackName}/replace-me-collectionId/replace-me-granuleId.hdf.met`,
                  fileStagingDir: `file-staging/${config.stackName}/replace-me-collectionId`,
                },
                {
                  bucket: config.buckets.internal.name,
                  filename: `s3://${config.buckets.internal.name}/file-staging/${config.stackName}/replace-me-collectionId/replace-me-granuleId_ndvi.jpg`,
                  fileStagingDir: `file-staging/${config.stackName}/replace-me-collectionId`,
                },
              ],
            },
          ],
        },
      });

      expectedSyncGranulePayload = loadFileWithUpdatedGranuleIdPathAndCollection(templatedSyncGranuleFilename, granuleId, testDataFolder, newCollectionId, config.stackName);

      expectedSyncGranulePayload.granules[0].dataType += testSuffix;
      expectedSyncGranulePayload.granules[0].files = addUrlPathToGranuleFiles(expectedSyncGranulePayload.granules[0].files, testId, '');

      const templatedOutputPayloadFilename = templateFile({
        inputTemplateFilename: './spec/parallel/ingestGranule/IngestGranule.output.payload.template.json',
        config: {
          granules: [
            {
              files: [
                {
                  bucket: config.buckets.protected.name,
                  filename: `s3://${config.buckets.protected.name}/MOD09GQ___006/2017/MOD/replace-me-granuleId.hdf`,
                },
                {
                  bucket: config.buckets.private.name,
                  filename: `s3://${config.buckets.private.name}/MOD09GQ___006/MOD/replace-me-granuleId.hdf.met`,
                },
                {
                  bucket: config.buckets.public.name,
                  filename: `s3://${config.buckets.public.name}/MOD09GQ___006/MOD/replace-me-granuleId_ndvi.jpg`,
                },
                {
                  bucket: config.buckets['protected-2'].name,
                  filename: `s3://${config.buckets['protected-2'].name}/MOD09GQ___006/MOD/replace-me-granuleId.cmr.xml`,
                },
              ],
            },
          ],
        },
      });

      expectedPayload = loadFileWithUpdatedGranuleIdPathAndCollection(templatedOutputPayloadFilename, granuleId, testDataFolder, newCollectionId);
      expectedPayload.granules[0].dataType += testSuffix;
      expectedPayload.granules = addUniqueGranuleFilePathToGranuleFiles(expectedPayload.granules, testId);
      expectedPayload.granules[0].files = addUrlPathToGranuleFiles(expectedPayload.granules[0].files, testId, collectionUrlString);
      // process.env.DISTRIBUTION_ENDPOINT needs to be set for below
      setDistributionApiEnvVars();

      console.log('Start SuccessExecution');
      workflowExecutionArn = await buildAndStartWorkflow(
        config.stackName,
        config.bucket,
        workflowName,
        collection,
        provider,
        inputPayload,
        {
          distribution_endpoint: process.env.DISTRIBUTION_ENDPOINT,
          workflow: 'PublishGranuleQueue',
        }
      );
    } catch (error) {
      beforeAllError = error;
      throw error;
    }
  });

  afterAll(async () => {
    // clean up stack state added by test
    await removePublishedGranule({
      prefix: config.stackName,
      granuleId: inputPayload.granules[0].granuleId,
    });
    await apiTestUtils.deletePdr({
      prefix: config.stackName,
      pdr: pdrFilename,
    });
    // The order of execution deletes matters. Parents must be deleted before children.
    await deleteExecution({ prefix: config.stackName, executionArn: publishGranuleExecutionArn });
    await deleteExecution({ prefix: config.stackName, executionArn: workflowExecutionArn });
    await Promise.all([
      deleteFolder(config.bucket, testDataFolder),
      deleteCollection({
        prefix: config.stackName,
        collectionName: collection.name,
        collectionVersion: collection.version,
      }),
      providerModel.delete(provider),
    ]);
  });

  beforeEach(() => {
    if (beforeAllError) fail(beforeAllError);
  });

  it('triggers a execution record being added to DynamoDB', async () => {
    if (beforeAllError) throw SetupError;

    const record = await waitForModelStatus(
      executionModel,
      { arn: workflowExecutionArn },
      ['running', 'completed']
    );
    expect(['running', 'completed'].includes(record.status)).toBeTrue();
  });

  it('triggers a PDR record being added to DynamoDB', async () => {
    if (beforeAllError) throw SetupError;
    const record = await waitForModelStatus(
      pdrModel,
      { pdrName: inputPayload.pdr.name },
      ['running', 'completed']
    );
    expect(['running', 'completed'].includes(record.status)).toBeTrue();
  });

  it('makes the granule available through the Cumulus API', async () => {
    if (beforeAllError) throw SetupError;
    await waitForModelStatus(
      granuleModel,
      { granuleId: inputPayload.granules[0].granuleId },
      ['completed']
    );

    const granule = await getGranule({
      prefix: config.stackName,
      granuleId: inputPayload.granules[0].granuleId,
    });
    expect(granule.granuleId).toEqual(inputPayload.granules[0].granuleId);
    expect((granule.status === 'running') || (granule.status === 'completed')).toBeTrue();
  });

  it('completes execution with success status', async () => {
    if (beforeAllError) throw SetupError;

    const workflowExecutionStatus = await waitForCompletedExecution(workflowExecutionArn);
    expect(workflowExecutionStatus).toEqual('SUCCEEDED');
  });

  it('can retrieve the specific provider that was created', async () => {
    if (beforeAllError) throw SetupError;

    const providerListResponse = await apiTestUtils.getProviders({ prefix: config.stackName });
    const providerList = JSON.parse(providerListResponse.body);
    expect(providerList.results.length).toBeGreaterThan(0);

    const providerResultResponse = await apiTestUtils.getProvider({ prefix: config.stackName, providerId: provider.id });
    const providerResult = JSON.parse(providerResultResponse.body);
    expect(providerResult).not.toBeNull();
  });

  it('can retrieve the specific collection that was created', async () => {
    if (beforeAllError) throw SetupError;

    const collectionListResponse = await apiTestUtils.getCollections({ prefix: config.stackName });
    const collectionList = JSON.parse(collectionListResponse.body);
    expect(collectionList.results.length).toBeGreaterThan(0);

    const collectionResponse = await apiTestUtils.getCollection(
      { prefix: config.stackName, collectionName: collection.name, collectionVersion: collection.version }
    );
    const collectionResult = JSON.parse(collectionResponse.body);
    expect(collectionResult).not.toBeNull();
  });

  it('results in the files being added to the granule files cache table', async () => {
    if (beforeAllError) throw SetupError;

    process.env.FilesTable = `${config.stackName}-FilesTable`;

    const lambdaOutput = await lambdaStep.getStepOutput(workflowExecutionArn, 'MoveGranules');

    await pMap(
      lambdaOutput.payload.granules[0].files,
      async (file) => {
        const { Bucket, Key } = parseS3Uri(file.filename);

        const granuleId = await pRetry(
          async () => {
            const id = await GranuleFilesCache.getGranuleId(Bucket, Key);
            if (id === undefined) throw new Error(`File not found in cache: s3://${Bucket}/${Key}`);
            return id;
          },
          { retries: 30, minTimeout: 2000, maxTimeout: 2000 }
        );

        expect(granuleId).toEqual(lambdaOutput.payload.granules[0].granuleId);
      },
      { concurrency: 1 }
    );
  });

  describe('the SyncGranules task', () => {
    let lambdaInput;
    let lambdaOutput;
    let subTestSetupError;

    beforeAll(async () => {
      try {
        lambdaInput = await lambdaStep.getStepInput(workflowExecutionArn, 'SyncGranule');
        lambdaOutput = await lambdaStep.getStepOutput(workflowExecutionArn, 'SyncGranule');
      } catch (error) {
        subTestSetupError = error;
      }
    });

    beforeEach(() => {
      if (beforeAllError) fail(beforeAllError);
      if (subTestSetupError) fail(subTestSetupError);
    });

    it('receives the correct collection and provider configuration', () => {
      if (beforeAllError || subTestSetupError) throw SetupError;
      expect(lambdaInput.meta.collection.name).toEqual(collection.name);
      expect(lambdaInput.meta.provider.id).toEqual(provider.id);
    });

    it('output includes the ingested granule with file staging location paths', () => {
      if (beforeAllError || subTestSetupError) throw SetupError;
      const updatedGranule = {
        ...expectedSyncGranulePayload.granules[0],
        sync_granule_duration: lambdaOutput.meta.input_granules[0].sync_granule_duration,
      };

      const updatedPayload = {
        ...expectedSyncGranulePayload,
        granules: [updatedGranule],
      };
      expect(lambdaOutput.payload).toEqual(updatedPayload);
    });

    it('updates the meta object with input_granules', () => {
      if (beforeAllError || subTestSetupError) throw SetupError;
      const updatedGranule = {
        ...expectedSyncGranulePayload.granules[0],
        sync_granule_duration: lambdaOutput.meta.input_granules[0].sync_granule_duration,
      };
      expect(lambdaOutput.meta.input_granules).toEqual([updatedGranule]);
    });
  });

  describe('the MoveGranules task', () => {
    let lambdaOutput;
    let files;
    let movedTaggings;
    let existCheck = [];
    let subTestSetupError;

    beforeAll(async () => {
      try {
        lambdaOutput = await lambdaStep.getStepOutput(workflowExecutionArn, 'MoveGranules');
        files = lambdaOutput.payload.granules[0].files;
        movedTaggings = await Promise.all(lambdaOutput.payload.granules[0].files.map((file) => {
          const { Bucket, Key } = parseS3Uri(file.filename);
          return s3GetObjectTagging(Bucket, Key);
        }));

        existCheck = await Promise.all([
          s3ObjectExists({ Bucket: files[0].bucket, Key: files[0].filepath }),
          s3ObjectExists({ Bucket: files[1].bucket, Key: files[1].filepath }),
          s3ObjectExists({ Bucket: files[2].bucket, Key: files[2].filepath }),
        ]);
      } catch (error) {
        beforeAllError = error;
      }
    });

    beforeEach(() => {
      if (beforeAllError) fail(beforeAllError);
      if (subTestSetupError) fail(subTestSetupError);
    });

    it('has a payload with correct buckets, filenames, sizes', () => {
      if (beforeAllError || subTestSetupError) throw SetupError;
      files.forEach((file) => {
        const expectedFile = expectedPayload.granules[0].files.find((f) => f.name === file.name);
        expect(file.filename).toEqual(expectedFile.filename);
        expect(file.bucket).toEqual(expectedFile.bucket);
        if (file.size && expectedFile.size) {
          expect(file.size).toEqual(expectedFile.size);
        }
      });
    });

    it('moves files to the bucket folder based on metadata', () => {
      if (beforeAllError || subTestSetupError) throw SetupError;
      existCheck.forEach((check) => {
        expect(check).toEqual(true);
      });
    });

    it('preserves tags on moved files', () => {
      if (beforeAllError || subTestSetupError) throw SetupError;
      movedTaggings.forEach((tagging) => {
        expect(tagging.TagSet).toEqual(expectedS3TagSet);
      });
    });
  });

  describe('the QueueWorkflow task', () => {
    let lambdaOutput;
    let subTestSetupError;

    beforeAll(async () => {
      try {
        lambdaOutput = await lambdaStep.getStepOutput(workflowExecutionArn, 'QueueWorkflow');
        publishGranuleExecutionArn = lambdaOutput.payload.running;
        console.log(publishGranuleExecutionArn);
      } catch (error) {
        subTestSetupError = error;
      }
    });

    beforeEach(() => {
      if (beforeAllError) fail(beforeAllError);
      if (subTestSetupError) fail(subTestSetupError);
    });

    it('results in a successful PublishGranuleQueue workflow execution', async () => {
      if (beforeAllError || subTestSetupError) throw SetupError;
      const publishGranuleExecutionStatus = await waitForCompletedExecution(
        publishGranuleExecutionArn
      );
      expect(publishGranuleExecutionStatus).toEqual('SUCCEEDED');
    });
  });

  describe('the queued workflow', () => {
    describe('the PostToCmr task', () => {
      let cmrResource;
      let ummCmrResource;
      let files;
      let granule;
      let resourceURLs;
      let teaRequestHeaders;

      let scienceFileUrl;
      let s3ScienceFileUrl;
      let browseImageUrl;
      let s3BrowseImageUrl;
      let s3CredsUrl;
      let subTestSetupError;

      beforeAll(async () => {
        process.env.CMR_ENVIRONMENT = 'UAT';
        postToCmrOutput = await lambdaStep.getStepOutput(publishGranuleExecutionArn, 'PostToCmr');

        if (postToCmrOutput === null) {
          beforeAllError = new Error(`Failed to get the PostToCmr step's output for ${workflowExecutionArn}`);
          return;
        }

        try {
          granule = postToCmrOutput.payload.granules[0];
          files = granule.files;

          const ummGranule = { ...granule, cmrMetadataFormat: 'umm_json_v1_6_2' };
          const result = await Promise.all([
            getOnlineResources(granule),
            getOnlineResources(ummGranule),
            getTEARequestHeaders(config.stackName),
          ]);

          cmrResource = result[0];
          ummCmrResource = result[1];
          resourceURLs = cmrResource.map((resource) => resource.href);
          teaRequestHeaders = result[2];

          scienceFileUrl = getDistributionFileUrl({ bucket: files[0].bucket, key: files[0].filepath });
          s3ScienceFileUrl = getDistributionFileUrl({ bucket: files[0].bucket, key: files[0].filepath, urlType: 's3' });
          browseImageUrl = getDistributionFileUrl({ bucket: files[2].bucket, key: files[2].filepath });
          s3BrowseImageUrl = getDistributionFileUrl({ bucket: files[2].bucket, key: files[2].filepath, urlType: 's3' });
          s3CredsUrl = resolve(process.env.DISTRIBUTION_ENDPOINT, 's3credentials');
        } catch (error) {
          subTestSetupError = error;
        }
      });

      beforeEach(() => {
        if (beforeAllError) fail(beforeAllError);
        if (subTestSetupError) fail(subTestSetupError);
      });

      it('publishes the granule metadata to CMR', async () => {
        if (beforeAllError || subTestSetupError) throw SetupError;
        const result = await conceptExists(granule.cmrLink);

        expect(granule.published).toEqual(true);
        expect(result).not.toEqual(false);
      });

      it('updates the CMR metadata online resources with the final metadata location', () => {
        if (beforeAllError || subTestSetupError) throw SetupError;

        console.log('parallel resourceURLs:', resourceURLs);
        console.log('s3CredsUrl:', s3CredsUrl);

        expect(resourceURLs).toContain(scienceFileUrl);
        expect(resourceURLs).toContain(s3ScienceFileUrl);
        expect(resourceURLs).toContain(browseImageUrl);
        expect(resourceURLs).toContain(s3BrowseImageUrl);
        expect(resourceURLs).toContain(s3CredsUrl);
      });

      it('updates the CMR metadata "online resources" with the proper types and urls', () => {
        if (beforeAllError || subTestSetupError) throw SetupError;
        const resource = ummCmrResource;
        const expectedTypes = [
          'GET DATA',
          'GET DATA VIA DIRECT ACCESS',
          'VIEW RELATED INFORMATION',
          'VIEW RELATED INFORMATION',
          'GET RELATED VISUALIZATION',
          'GET RELATED VISUALIZATION',
          'VIEW RELATED INFORMATION',
        ];
        const cmrUrls = resource.map((r) => r.URL);
        expect(cmrUrls).toContain(scienceFileUrl);
        expect(cmrUrls).toContain(s3ScienceFileUrl);
        expect(cmrUrls).toContain(browseImageUrl);
        expect(cmrUrls).toContain(s3BrowseImageUrl);
        expect(cmrUrls).toContain(s3CredsUrl);
        expect(resource.map((r) => r.Type).sort()).toEqual(expectedTypes.sort());
      });

      it('includes the Earthdata login ID for requests to protected science files', async () => {
        if (beforeAllError || subTestSetupError) throw SetupError;
        const filepath = `/${files[0].bucket}/${files[0].filepath}`;
        const s3SignedUrl = await getTEADistributionApiRedirect(filepath, teaRequestHeaders);
        const earthdataLoginParam = new URL(s3SignedUrl).searchParams.get('A-userid');
        expect(earthdataLoginParam).toEqual(process.env.EARTHDATA_USERNAME);
      });

      it('downloads the requested science file for authorized requests', async () => {
        if (beforeAllError || subTestSetupError) throw SetupError;
        const scienceFileUrls = resourceURLs
          .filter((url) =>
            (url.startsWith(process.env.DISTRIBUTION_ENDPOINT) ||
          url.match(/s3\.amazonaws\.com/)) &&
          !url.endsWith('.cmr.xml') &&
          !url.includes('s3credentials'));

        const checkFiles = await Promise.all(
          scienceFileUrls
            .map(async (url) => {
              const extension = path.extname(new URL(url).pathname);
              const sourceFile = s3data.find((d) => d.endsWith(extension));
              const sourceChecksum = await generateChecksumFromStream(
                'cksum',
                fs.createReadStream(require.resolve(sourceFile))
              );
              const file = files.find((f) => f.name.endsWith(extension));

              const filepath = `/${file.bucket}/${file.filepath}`;
              const fileStream = await getTEADistributionApiFileStream(filepath, teaRequestHeaders);
              // Compare checksum of downloaded file with expected checksum.
              const downloadChecksum = await generateChecksumFromStream('cksum', fileStream);
              return downloadChecksum === sourceChecksum;
            })
        );

        checkFiles.forEach((fileCheck) => expect(fileCheck).toBeTrue());
      });
    });
  });
});
