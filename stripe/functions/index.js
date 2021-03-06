/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();
const logging = require('@google-cloud/logging')();
const stripe = require('stripe')(functions.config().stripe.token);
const currency = functions.config().stripe.currency || 'USD';

// [START chargecustomer]
// Charge the Stripe customer whenever an amount is written to the Realtime database
exports.createStripeCharge = functions.database.ref('/stripe_customers/{userId}/charges/{id}')
    .onCreate(async (snap, context) => {
      const val = snap.val();
      try {
        // Look up the Stripe customer id written in createStripeCustomer
        const snapshot = await admin.database().ref(`/stripe_customers/${context.params.userId}/customer_id`)
            .once('value')
        const customer = snapshot.val();
        // Create a charge using the pushId as the idempotency key
        // protecting against double charges
        const amount = val.amount;
        const idempotencyKey = context.params.id;
        const charge = {amount, currency, customer};
        if (val.source !== null) {
          charge.source = val.source;
        }
        const response = await stripe.charges.create(charge, {idempotency_key: idempotencyKey});
        // If the result is successful, write it back to the database
        return snap.ref.set(response);
      } catch(error) {
        // We want to capture errors and render them in a user-friendly way, while
        // still logging an exception with StackDriver
        await snap.ref.child('error').set(userFacingMessage(error));
        return reportError(error, {user: context.params.userId});
      }
    });
// [END chargecustomer]]

// When a user is created, register them with Stripe
exports.createStripeCustomer = functions.auth.user().onCreate(async (user) => {
  const customer = await stripe.customers.create({email: user.email});
  return admin.database().ref(`/stripe_customers/${user.uid}/customer_id`).set(customer.id);
});

// Add a payment source (card) for a user by writing a stripe payment source token to Realtime database
exports.addPaymentSource = functions.database
    .ref('/stripe_customers/{userId}/sources/{pushId}/token').onWrite(async (change, context) => {
      const source = change.after.val();
      if (source === null){
        return null;
      }

      try {
        const snapshot = await admin.database().ref(`/stripe_customers/${context.params.userId}/customer_id`).once('value');
        const customer =  snapshot.val();
        const response = await stripe.customers.createSource(customer, {source});
        return change.after.ref.parent.set(response);
      } catch (error) {
        await change.after.ref.parent.child('error').set(userFacingMessage(error));
        return reportError(error, {user: context.params.userId});
      }
    });

// When a user deletes their account, clean up after them
exports.cleanupUser = functions.auth.user().onDelete(async (user) => {
  const snapshot = await admin.database().ref(`/stripe_customers/${user.uid}`).once('value');
  const customer = snapshot.val();
  await stripe.customers.del(customer.customer_id);
  return admin.database().ref(`/stripe_customers/${user.uid}`).remove();
});

// To keep on top of errors, we should raise a verbose error report with Stackdriver rather
// than simply relying on console.error. This will calculate users affected + send you email
// alerts, if you've opted into receiving them.
// [START reporterror]
function reportError(err, context = {}) {
  // This is the name of the StackDriver log stream that will receive the log
  // entry. This name can be any valid log stream name, but must contain "err"
  // in order for the error to be picked up by StackDriver Error Reporting.
  const logName = 'errors';
  const log = logging.log(logName);

  // https://cloud.google.com/logging/docs/api/ref_v2beta1/rest/v2beta1/MonitoredResource
  const metadata = {
    resource: {
      type: 'cloud_function',
      labels: {function_name: process.env.FUNCTION_NAME},
    },
  };

  // https://cloud.google.com/error-reporting/reference/rest/v1beta1/ErrorEvent
  const errorEvent = {
    message: err.stack,
    serviceContext: {
      service: process.env.FUNCTION_NAME,
      resourceType: 'cloud_function',
    },
    context: context,
  };

  // Write the error log entry
  return new Promise((resolve, reject) => {
    log.write(log.entry(metadata, errorEvent), (error) => {
      if (error) {
       return reject(error);
      }
      return resolve();
    });
  });
}
// [END reporterror]

// Sanitize the error message for the user
function userFacingMessage(error) {
  return error.type ? error.message : 'An error occurred, developers have been alerted';
}
